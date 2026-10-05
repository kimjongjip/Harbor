import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { remoteCodexCommand, shellQuote } from "./ssh.js";

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
const posix = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

test(
  "remote launcher loads login PATH and keeps startup noise out of protocol stdout",
  { skip: !existsSync(bash) },
  (t) => {
    const root = mkdtempSync(resolve(".cache/ssh-launch-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "user bin");
    mkdirSync(bin);
    const cli = join(bin, "codex");
    writeFileSync(
      cli,
      "#!/bin/bash\nprintf 'RESULT'; printf '|%s' \"$@\"; printf '\\n'\n",
      { mode: 0o700 },
    );
    const login = join(root, "login-shell");
    writeFileSync(
      login,
      `#!/bin/bash\nprintf 'startup banner\\n'\nexport PATH=${shellQuote(posix(bin))}:$PATH\nexec /bin/bash --noprofile --norc -c "$2"\n`,
      { mode: 0o700 },
    );
    const run = (command: string, interactiveOnly = false) =>
      spawnSync(bash, ["--noprofile", "--norc", "-c", command], {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          SHELL: posix(login),
          HARBOR_TEST_INTERACTIVE: interactiveOnly ? "1" : "",
        },
      });
    const args = ["app-server", "--listen", "stdio://", "a'b $(printf unsafe)"];
    const result = run(remoteCodexCommand({ codexPath: "codex" }, args));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `RESULT|${args.join("|")}`);

    writeFileSync(
      login,
      `#!/bin/bash\nprintf 'startup banner\\n'\nexport PATH=/usr/bin:/bin\nif [ "$1" = '-ilc' ]; then export PATH=${shellQuote(posix(bin))}:$PATH; fi\nexec /bin/bash --noprofile --norc -c "$2"\n`,
      { mode: 0o700 },
    );
    const fallback = run(
      remoteCodexCommand({ codexPath: "codex" }, ["--version"]),
    );
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(fallback.stdout.trim(), "RESULT|--version");

    const missing = run(
      remoteCodexCommand({ codexPath: `${posix(root)}/missing/codex` }, []),
    );
    assert.equal(missing.status, 127);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /missing\/codex/);

    const unusual = join(bin, "a'b $(printf unsafe)");
    writeFileSync(unusual, "#!/bin/bash\nprintf 'EXPLICIT:%s' \"$PWD\"\n", {
      mode: 0o700,
    });
    const explicit = run(
      remoteCodexCommand({ codexPath: posix(unusual) }, [], posix(root)),
    );
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout, `EXPLICIT:${posix(root)}`);
  },
);
