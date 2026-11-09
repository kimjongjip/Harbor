import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryResumer } from "./history-resume.js";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import type { HistoryThread } from "../shared/history.js";
import type { Terminals } from "./terminals.js";

const host: HostConfig = {
  id: "ssh-fixture",
  name: "SSH fixture",
  kind: "ssh",
  address: "fixture.invalid",
  username: "fixture",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "~",
  mode: "auto",
  color: "#123456",
  createdAt: 0,
};
const id = "0199aaaa-1111-7111-8111-111111111111";
function fixture() {
  const list: TerminalInfo[] = [],
    calls: Parameters<Terminals["create"]>[] = [];
  const thread: HistoryThread = {
    id,
    hostId: host.id,
    title: "Synthetic saved conversation",
    cwd: "/project",
    preview: "",
    updatedAt: 0,
    source: "cli",
    active: false,
  };
  let summaryCount = 0,
    passwordCount = 0;
  let waitForSummary: Promise<void> | undefined;
  let fail = false;
  const terminals: Pick<Terminals, "list" | "create" | "setColors"> = {
    list: () => list,
    setColors: () => {},
    create: async (...args) => {
      calls.push(args);
      if (fail) throw new Error("Synthetic unavailable tmux");
      const [actualHost, cwd, , options] = args;
      const info: TerminalInfo = {
        id: "terminal-" + calls.length,
        hostId: actualHost.id,
        cwd,
        title: options!.title!,
        program: options!.program,
        resumeThreadId: options!.resumeThreadId,
        exited: false,
        persistent: options!.sshSessionMode === "tmux",
        connectionState: "connected",
      };
      list.push(info);
      return info;
    },
  };
  const resumer = new HistoryResumer(
    terminals,
    async () => {
      passwordCount++;
      return "synthetic-password";
    },
    async () => {
      summaryCount++;
      await waitForSummary;
      return thread;
    },
    (cwd) => {
      if (!cwd || /[\0\r\n]/.test(cwd)) throw Error("Invalid cwd");
      return cwd;
    },
  );
  return {
    resumer,
    list,
    calls,
    thread,
    get summaryCount() {
      return summaryCount;
    },
    get passwordCount() {
      return passwordCount;
    },
    set wait(value: Promise<void>) {
      waitForSummary = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
  };
}

test("both providers resume the same saved ID with the chosen mode and original Claude directory", async () => {
  for (const provider of ["codex", "claude"] as const) {
    for (const mode of [undefined, "direct", "tmux"] as const) {
      const f = fixture();
      const result = await f.resumer.resume(host, id, {
        provider,
        sshSessionMode: mode,
      });
      const [actualHost, cwd, password, options] = f.calls[0];
      assert.equal(actualHost.id, host.id);
      assert.equal(cwd, "/project");
      assert.equal(password, "synthetic-password");
      assert.equal(options?.sshSessionMode, mode || "direct");
      assert.equal(
        options?.program,
        provider === "claude" ? "claude-resume" : "resume",
      );
      assert.equal(options?.resumeThreadId, id);
      assert.equal(
        options?.resumeCwd,
        provider === "claude" ? "/project" : undefined,
      );
      assert.equal(result.resumeThreadId, id);
    }
  }
});

test("simultaneous different mode requests launch only one writer and existing connections keep their mode", async () => {
  const f = fixture();
  let release!: () => void;
  f.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.resumer.resume(host, id, {
    provider: "claude",
    sshSessionMode: "tmux",
  });
  const second = f.resumer.resume(host, id, {
    provider: "claude",
    sshSessionMode: "direct",
  });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(a.persistent, true);
  assert.equal(f.calls.length, 1);
  const again = await f.resumer.resume(host, id, {
    provider: "claude",
    sshSessionMode: "direct",
  });
  assert.equal(again.id, a.id);
  assert.equal(again.persistent, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.summaryCount, 1);
  assert.equal(f.passwordCount, 1);
});

test("existing native session IDs are matched within host and provider; exited sessions can resume anew", async () => {
  const f = fixture();
  const first = await f.resumer.resume(host, id, { provider: "codex" });
  first.agentSessionId = id;
  delete first.resumeThreadId;
  assert.equal(
    (
      await f.resumer.resume(host, id, {
        provider: "codex",
        sshSessionMode: "tmux",
      })
    ).id,
    first.id,
  );
  assert.notEqual(
    (await f.resumer.resume(host, id, { provider: "claude" })).id,
    first.id,
  );
  assert.notEqual(
    (
      await f.resumer.resume({ ...host, id: "other-host" }, id, {
        provider: "codex",
      })
    ).id,
    first.id,
  );
  first.exited = true;
  const reopened = await f.resumer.resume(host, id, {
    provider: "codex",
    sshSessionMode: "tmux",
  });
  assert.notEqual(reopened.id, first.id);
  assert.equal(reopened.persistent, true);
});

test("local tmux, externally active conversations and invalid paths never launch a terminal", async () => {
  const f = fixture();
  await assert.rejects(
    f.resumer.resume({ ...host, kind: "local" }, id, {
      provider: "claude",
      sshSessionMode: "tmux",
    }),
    /SSH 서버/,
  );
  assert.equal(f.passwordCount, 0);
  f.thread.active = true;
  await assert.rejects(
    f.resumer.resume(host, id, { provider: "codex", sshSessionMode: "tmux" }),
    /실행 중/,
  );
  f.thread.active = false;
  f.thread.cwd = "bad\npath";
  await assert.rejects(
    f.resumer.resume(host, id, { provider: "claude" }),
    /Invalid cwd/,
  );
  assert.equal(f.calls.length, 0);
});

test("failed tmux resume releases the pending slot so a user can retry with direct SSH", async () => {
  const f = fixture();
  f.fail = true;
  await assert.rejects(
    f.resumer.resume(host, id, { provider: "codex", sshSessionMode: "tmux" }),
    /unavailable tmux/,
  );
  assert.equal(f.list.length, 0);
  f.fail = false;
  const retried = await f.resumer.resume(host, id, {
    provider: "codex",
    sshSessionMode: "direct",
  });
  assert.equal(retried.persistent, false);
  assert.equal(f.calls.length, 2);
});
