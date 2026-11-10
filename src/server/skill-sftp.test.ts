import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import ssh2, { type Connection } from "ssh2";
const { Server, Client, utils } = ssh2;
import { Files } from "./files.js";
import { SkillLibrary } from "./skill-library.js";
import type { HostConfig } from "../shared/types.js";

test(
  "real SSH/SFTP transport resolves the remote login home and custom Claude config, copies bytes and preserves sessions",
  { timeout: 60000 },
  async (t) => {
    const parent = path.resolve(".cache/skill-sftp-tests");
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "run-"));
    const filename = (remote: string) => {
      const local = path.resolve(
        directory,
        ...remote.split("/").filter(Boolean),
      );
      assert.ok(local === directory || local.startsWith(directory + path.sep));
      return local;
    };
    await fs.mkdir(filename("/home/tester"), { recursive: true });
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs1", format: "pem" });
    const handles = new Map<string, fs.FileHandle>(),
      commands: string[] = [],
      peers = new Set<Connection>();
    let next = 0;
    const server = new Server({ hostKeys: [privateKey] }, (peer) => {
      peers.add(peer);
      peer.on("error", () => {});
      peer.on("close", () => peers.delete(peer));
      peer.on("authentication", (context) => context.accept());
      peer.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          commands.push(info.command);
          const channel = accept();
          channel.write("/home/tester\0/home/tester/custom-claude\0");
          channel.exit(0);
          channel.end();
        });
        session.on("sftp", (accept) => {
          const sftp = accept();
          const status = utils.sftp.STATUS_CODE;
          const wrap = (id: number, fn: () => Promise<void>) =>
            void fn().catch((e) =>
              sftp.status(
                id,
                e.code === "ENOENT"
                  ? status.NO_SUCH_FILE
                  : e.code === "EACCES"
                    ? status.PERMISSION_DENIED
                    : status.FAILURE,
              ),
            );
          const attrs = (stat: Awaited<ReturnType<typeof fs.stat>>) => ({
            mode: Number(stat.mode),
            uid: 1000,
            gid: 1000,
            size: Number(stat.size),
            atime: Math.floor(Number(stat.atimeMs) / 1000),
            mtime: Math.floor(Number(stat.mtimeMs) / 1000),
          });
          sftp.on("LSTAT", (id, name) =>
            wrap(id, async () => {
              sftp.attrs(id, attrs(await fs.lstat(filename(name))));
            }),
          );
          sftp.on("STAT", (id, name) =>
            wrap(id, async () => {
              sftp.attrs(id, attrs(await fs.stat(filename(name))));
            }),
          );
          sftp.on("FSTAT", (id, handle) =>
            wrap(id, async () => {
              sftp.attrs(
                id,
                attrs(await handles.get(handle.toString())!.stat()),
              );
            }),
          );
          sftp.on("MKDIR", (id, name) =>
            wrap(id, async () => {
              await fs.mkdir(filename(name));
              sftp.status(id, status.OK);
            }),
          );
          sftp.on("OPEN", (id, name, flags) =>
            wrap(id, async () => {
              const handle = Buffer.from(String(++next));
              handles.set(
                handle.toString(),
                await fs.open(filename(name), utils.sftp.flagsToString(flags)!),
              );
              sftp.handle(id, handle);
            }),
          );
          sftp.on("WRITE", (id, handle, offset, data) =>
            wrap(id, async () => {
              await handles
                .get(handle.toString())!
                .write(data, 0, data.length, offset);
              sftp.status(id, status.OK);
            }),
          );
          sftp.on("READ", (id, handle, offset, length) =>
            wrap(id, async () => {
              const bytes = Buffer.alloc(length),
                result = await handles
                  .get(handle.toString())!
                  .read(bytes, 0, length, offset);
              if (result.bytesRead)
                sftp.data(id, bytes.subarray(0, result.bytesRead));
              else sftp.status(id, status.EOF);
            }),
          );
          sftp.on("CLOSE", (id, handle) =>
            wrap(id, async () => {
              await handles.get(handle.toString())!.close();
              handles.delete(handle.toString());
              sftp.status(id, status.OK);
            }),
          );
          sftp.on("RENAME", (id, from, to) =>
            wrap(id, async () => {
              await fs.link(filename(from), filename(to));
              await fs.unlink(filename(from));
              sftp.status(id, status.OK);
            }),
          );
          sftp.on("REMOVE", (id, name) =>
            wrap(id, async () => {
              await fs.unlink(filename(name));
              sftp.status(id, status.OK);
            }),
          );
          sftp.on("RMDIR", (id, name) =>
            wrap(id, async () => {
              await fs.rmdir(filename(name));
              sftp.status(id, status.OK);
            }),
          );
        });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const connection = new Client();
    connection.on("error", () => {});
    t.after(async () => {
      connection.end();
      for (const peer of peers) peer.end();
      for (const handle of handles.values())
        await handle.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    connection.connect({
      host: "127.0.0.1",
      port: (server.address() as any).port,
      username: "fixture",
    });
    await once(connection, "ready");
    const sftp = await new Promise<any>((resolve, reject) =>
      connection.sftp((e, value) => (e ? reject(e) : resolve(value))),
    );
    const files = new Files(() => undefined);
    (files as any).connections.set("fixture", { connection, sftp });
    const host = { id: "fixture", kind: "ssh" } as HostConfig;
    const binary = Buffer.alloc(150000, 197);
    const library = new SkillLibrary({
      files,
      download: async () => [
        {
          path: "SKILL.md",
          bytes: Buffer.from("---\nname: pdf\ndescription: Fixture\n---\n"),
          executable: false,
        },
        { path: "assets/font.bin", bytes: binary, executable: false },
        {
          path: "scripts/check.py",
          bytes: Buffer.from("raise Exception('Do not execute')"),
          executable: true,
        },
      ],
    });
    const initial = await library.status(host);
    assert.equal(initial.roots.claude, "/home/tester/custom-claude/skills");
    assert.equal(initial.roots.codex, "/home/tester/.agents/skills");
    assert.deepEqual(
      (await library.install(host, ["pdf"], ["claude", "codex"])).map(
        (r) => r.state,
      ),
      ["installed", "installed"],
    );
    for (const root of Object.values(initial.roots))
      assert.deepEqual(
        await fs.readFile(filename(`${root}/pdf/assets/font.bin`)),
        binary,
      );
    assert.deepEqual((await library.status(host)).skills.pdf, {
      claude: "installed",
      codex: "installed",
    });
    assert.deepEqual(
      (await library.install(host, ["pdf"], ["claude", "codex"])).map(
        (r) => r.state,
      ),
      ["existing", "existing"],
    );
    assert.ok(
      commands.every(
        (command) =>
          command.includes("CLAUDE_CONFIG_DIR") &&
          !/\b(auth|login|codex|claude|kill|restart)\b/.test(
            command.replaceAll(".claude", ""),
          ),
      ),
    );
    assert.equal(
      peers.size,
      1,
      "file operations do not close or restart the SSH connection",
    );
    assert.equal(handles.size, 0);
  },
);
