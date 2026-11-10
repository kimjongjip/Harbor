import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import {
  codexHistoryTitle,
  recoverTerminalHistorySession,
} from "./terminal-history-session";

const id = "11111111-2222-4333-8444-555555555555";
const title = "공유 대화 표시 확인";
const answer =
  "The completed answer belongs to this synthetic conversation, with enough distinct text to verify the native screen before reading saved history.";
function screen(text = answer, name = title) {
  const native = new headless.Terminal({
    cols: 253,
    rows: 44,
    allowProposedApi: true,
  });
  const seed = async (value = text, label = name) =>
    new Promise<void>((done) =>
      native.write(
        `\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H${value}\x1b[38;1H  Worked for 1m 2s\x1b[41;1H› UNSENT DRAFT\x1b[43;1H  GPT-6-Astra xhigh · ~ · ${label}\x1b[44;1H  ← for agents · ? for shortcuts                     ⚠ 1 warning · f2 to view\x1b[41;15H`,
        done,
      ),
    );
  return { native, term: native as unknown as Terminal, seed };
}
function history(text = answer) {
  const thread = {
    id,
    hostId: "fixture",
    title,
    provider: "codex",
    cwd: "/fixture",
    preview: "",
    source: "cli",
    active: false,
    updatedAt: 1,
  };
  return {
    page: { data: [thread], nextCursor: null },
    detail: {
      thread,
      items: [
        {
          id: "a",
          kind: "assistant",
          text,
          turnId: "turn",
          phase: "final_answer",
          turnStatus: "completed",
        },
      ],
      nextCursor: null,
    },
  };
}
test("shared Codex history recovers from a unique title and a completed native answer", async () => {
  const f = screen(),
    h = history(),
    requests: string[] = [];
  try {
    await f.seed();
    assert.equal(codexHistoryTitle(f.term), title);
    const before = f.native.buffer.active.getLine(40)?.translateToString(true);
    const result = await recoverTerminalHistorySession(
      f.term,
      "fixture",
      title,
      async <T>(path: string) => {
        requests.push(path);
        return (path.includes(`/${id}?`) ? h.detail : h.page) as T;
      },
    );
    assert.equal(result, id);
    assert.equal(requests.length, 2);
    assert.equal(
      new URL(requests[0], "https://fixture.test").searchParams.get("search"),
      title,
    );
    assert.equal(
      f.native.buffer.active.getLine(40)?.translateToString(true),
      before,
    );
    assert.equal(f.native.cols, 253);
  } finally {
    f.native.dispose();
  }
});
test("a quoted footer, shell, disabled parser or clipped title never starts recovery", async () => {
  const f = screen();
  try {
    await f.seed(answer, title + "…");
    assert.equal(codexHistoryTitle(f.term), undefined);
    await f.seed();
    await new Promise<void>((done) => f.native.write("\x1b[?2004l", done));
    assert.equal(codexHistoryTitle(f.term), undefined);
    await f.seed();
    await new Promise<void>((done) => f.native.write("\x1b[?1049l", done));
    assert.equal(codexHistoryTitle(f.term), undefined);
    await f.seed();
    await new Promise<void>((done) =>
      f.native.write(
        "\x1b[43;1H\x1b[2K  Quoted model and conversation title",
        done,
      ),
    );
    assert.equal(codexHistoryTitle(f.term), undefined);
  } finally {
    f.native.dispose();
  }
});
test("duplicates, unread pages, wrong host/provider/ID, and foreign details fail closed", async () => {
  const f = screen();
  try {
    await f.seed();
    for (const edit of [
      (h: any) =>
        h.page.data.push({
          ...h.page.data[0],
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      (h: any) => (h.page.nextCursor = "more"),
      (h: any) => (h.page.data[0].hostId = "foreign"),
      (h: any) => (h.page.data[0].provider = "claude"),
      (h: any) => (h.page.data[0].id = "not-a-session-id"),
      (h: any) =>
        (h.detail.thread = {
          ...h.detail.thread,
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      (h: any) => (h.detail.thread = { ...h.detail.thread, hostId: "foreign" }),
      (h: any) =>
        (h.detail.thread = { ...h.detail.thread, title: "Other title" }),
    ]) {
      const h = history();
      edit(h);
      assert.equal(
        await recoverTerminalHistorySession(
          f.term,
          "fixture",
          title,
          async <T>(path: string) =>
            (path.includes(`/${id}?`) ? h.detail : h.page) as T,
        ),
        undefined,
      );
    }
  } finally {
    f.native.dispose();
  }
});
test("same title without a long completed answer cannot select history or match the draft", async () => {
  const f = screen();
  try {
    await f.seed();
    for (const text of [
      "Done",
      "This is a different completed answer with enough characters to pass the length check, but it is absent from the current native terminal.",
    ]) {
      const h = history(text);
      assert.equal(
        await recoverTerminalHistorySession(
          f.term,
          "fixture",
          title,
          async <T>(path: string) =>
            (path.includes(`/${id}?`) ? h.detail : h.page) as T,
        ),
        undefined,
      );
    }
    const h = history();
    h.detail.items[0].turnStatus = "inProgress";
    assert.equal(
      await recoverTerminalHistorySession(
        f.term,
        "fixture",
        title,
        async <T>(path: string) =>
          (path.includes(`/${id}?`) ? h.detail : h.page) as T,
      ),
      undefined,
    );
    await f.seed("No saved answer here");
    await new Promise<void>((done) =>
      f.native.write(`\x1b[41;1H› ${answer}\x1b[41;3H`, done),
    );
    const complete = history();
    assert.equal(
      await recoverTerminalHistorySession(
        f.term,
        "fixture",
        title,
        async <T>(path: string) =>
          (path.includes(`/${id}?`) ? complete.detail : complete.page) as T,
      ),
      undefined,
    );
  } finally {
    f.native.dispose();
  }
});
test("a native session change while history is loading rejects the late result", async () => {
  const f = screen(),
    h = history();
  try {
    await f.seed();
    const result = await recoverTerminalHistorySession(
      f.term,
      "fixture",
      title,
      async <T>(path: string) => {
        if (path.includes(`/${id}?`)) {
          await f.seed(answer, "Changed conversation");
          return h.detail as T;
        }
        return h.page as T;
      },
    );
    assert.equal(result, undefined);
  } finally {
    f.native.dispose();
  }
});
