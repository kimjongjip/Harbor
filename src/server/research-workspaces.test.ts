import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve, sep, posix } from "node:path";
import { execFileSync } from "node:child_process";
import {
  prepareResearchWorkspaces,
  prepareRemoteResearchWorkspaces,
} from "./research-workspaces.js";
import type { HostConfig } from "../shared/types.js";
import { shellQuote } from "./ssh.js";

test("code research creates two independent branches without changing the original worktree", async (t) => {
  const parent = resolve(".cache/research-workspaces-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  const project = join(root, "project");
  mkdirSync(project);
  t.after(() => {
    assert.ok(resolve(root).startsWith(parent + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: project,
      windowsHide: true,
      encoding: "utf8",
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(project, "example.txt"), "baseline");
  git("add", ".");
  git("commit", "-m", "fixture baseline");
  const baseline = git("rev-parse", "HEAD");
  const prepared = await prepareResearchWorkspaces(
    join(root, "data"),
    project,
    "code",
  );
  assert.equal(prepared.workspace?.baseline, baseline);
  assert.equal(prepared.folders.length, 2);
  writeFileSync(join(prepared.folders[0], "example.txt"), "Claude edits");
  assert.equal(
    readFileSync(join(prepared.folders[1], "example.txt"), "utf8"),
    "baseline",
  );
  assert.equal(readFileSync(join(project, "example.txt"), "utf8"), "baseline");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("branch", "--show-current"), "main");
  const partnerOnly = await prepareResearchWorkspaces(
    join(root, "partner-data"),
    project,
    "code",
    ["codex"],
  );
  assert.equal(partnerOnly.folders.length, 1);
  assert.equal(partnerOnly.workspace?.branches.length, 1);
  assert.equal(partnerOnly.workspace?.baseline, baseline);
  assert.equal(
    readFileSync(join(partnerOnly.folders[0], "example.txt"), "utf8"),
    "baseline",
  );
  assert.equal(git("status", "--porcelain"), "");
  writeFileSync(join(project, "example.txt"), "uncommitted user edit");
  await assert.rejects(
    prepareResearchWorkspaces(join(root, "other"), project, "code"),
    /Git 변경/,
  );
  assert.equal(
    readFileSync(join(project, "example.txt"), "utf8"),
    "uncommitted user edit",
  );
});

test("remote workspace setup routes to the selected server and rejects unexpected server paths", async () => {
  const host = { id: "fixture-ssh", kind: "ssh" } as HostConfig;
  const seen: string[] = [];
  let bad = false;
  const remote = {
    researchDirectory: async (selected: HostConfig, cwd: string) => {
      assert.equal(selected.id, host.id);
      seen.push(cwd);
      return cwd === "~" ? "/home/fixture" : "/srv/project with 'quotes'";
    },
    researchCommand: async (selected: HostConfig, command: string) => {
      assert.equal(selected.id, host.id);
      const encoded = command.match(
        /base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/,
      )?.[1];
      assert.ok(encoded);
      const script = Buffer.from(encoded, "base64").toString();
      const data = script.match(
        /base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/,
      )?.[1];
      assert.ok(data);
      const input = JSON.parse(Buffer.from(data, "base64").toString());
      assert.equal(input.cwd, "/srv/project with 'quotes'");
      assert.equal(input.kind, "ideas");
      assert.ok(
        input.folders.every(
          (p: string) =>
            posix.isAbsolute(p) &&
            p.startsWith("/home/fixture/.codex/harbor/research-workspaces/"),
        ),
      );
      return `login banner\n${input.marker}${JSON.stringify({ folders: bad ? ["/wrong"] : input.folders })}\n`;
    },
  };
  const prepared = await prepareRemoteResearchWorkspaces(
    host,
    "~/project",
    "ideas",
    remote,
  );
  assert.equal(prepared.folders.length, 2);
  assert.deepEqual(seen, ["~/project", "~"]);
  bad = true;
  await assert.rejects(
    prepareRemoteResearchWorkspaces(host, "~/project", "ideas", remote),
    /일치하지/,
  );
});

const fixturePython = process.env.HARBOR_TEST_PYTHON;
const fixtureBash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
test(
  "remote preparation command creates real independent worktrees through a local POSIX shell fixture",
  { skip: !fixturePython || !existsSync(fixtureBash) },
  async (t) => {
    const parent = resolve(".cache/remote-workspace-tests");
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, "run-")),
      project = join(dir, "project with 'quote'");
    mkdirSync(project);
    t.after(() => {
      assert.ok(resolve(dir).startsWith(parent + sep));
      rmSync(dir, { recursive: true, force: true });
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: project,
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    writeFileSync(join(project, "source.txt"), "baseline");
    git("add", ".");
    git("commit", "-m", "fixture");
    const posixPath = (p: string) =>
      p.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
    const bashPath = (p: string) =>
      p
        .replaceAll("\\", "/")
        .replace(
          /^([A-Za-z]):/,
          (_, letter: string) => `/${letter.toLowerCase()}`,
        );
    const host = { id: "local-ssh-fixture", kind: "ssh" } as HostConfig;
    const remote = {
      researchDirectory: async (_host: HostConfig, p: string) =>
        p === "~" ? posixPath(dir) : posixPath(project),
      researchCommand: async (_host: HostConfig, command: string) => {
        const script = join(dir, "prepare.sh");
        writeFileSync(
          script,
          `function python3() { ${shellQuote(bashPath(fixturePython!))} "$@"; }; export -f python3;\n${command}\n`,
        );
        let output = execFileSync(
          fixtureBash,
          ["--noprofile", "--norc", bashPath(script)],
          {
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, HOME: bashPath(dir), SHELL: "/bin/bash" },
          },
        );
        // The fixture runs Python on Windows; normalize its native Git repository result to emulate POSIX SSH.
        output = output
          .split(/\r?\n/)
          .map((line) => {
            const at = line.indexOf(":");
            if (!line.startsWith("HARBOR_RESEARCH_") || at < 0) return line;
            const result = JSON.parse(line.slice(at + 1));
            if (result.workspace)
              result.workspace.repository = posixPath(
                result.workspace.repository,
              );
            return line.slice(0, at + 1) + JSON.stringify(result);
          })
          .join("\n");
        return output;
      },
    };
    const ideas = await prepareRemoteResearchWorkspaces(
      host,
      "~/project",
      "ideas",
      remote,
    );
    for (const folder of ideas.folders) assert.ok(existsSync(folder));
    const prepared = await prepareRemoteResearchWorkspaces(
      host,
      "~/project",
      "code",
      remote,
    );
    assert.equal(prepared.workspace?.baseline, git("rev-parse", "HEAD"));
    writeFileSync(
      join(prepared.folders[0], "source.txt"),
      "Claude fixture edits",
    );
    assert.equal(
      readFileSync(join(prepared.folders[1], "source.txt"), "utf8"),
      "baseline",
    );
    assert.equal(readFileSync(join(project, "source.txt"), "utf8"), "baseline");
    assert.equal(git("status", "--porcelain"), "");
    writeFileSync(join(project, "source.txt"), "uncommitted fixture edit");
    await assert.rejects(
      prepareRemoteResearchWorkspaces(host, "~/project", "code", remote),
      /Uncommitted Git changes/,
    );
    assert.equal(
      readFileSync(join(project, "source.txt"), "utf8"),
      "uncommitted fixture edit",
    );
  },
);
