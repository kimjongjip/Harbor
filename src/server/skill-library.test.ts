import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import {
  SkillLibrary,
  createSkillRouter,
  skillTransport,
  installSkill,
  validateSkillFiles,
  downloadSkill,
  type SkillPayload,
  type SkillTransport,
} from "./skill-library.js";
import { SKILL_CATALOG, SKILL_SOURCE } from "../shared/skill-catalog.js";
import source from "./skill-source.json";
import type { HostConfig } from "../shared/types.js";

const payload: SkillPayload = [
  {
    path: "SKILL.md",
    bytes: Buffer.from("---\nname: pdf\ndescription: Synthetic fixture\n---\n"),
    executable: false,
  },
  {
    path: "scripts/tool.py",
    bytes: Buffer.from("raise Exception('Never execute this fixture')"),
    executable: true,
  },
  {
    path: "assets/picture.png",
    bytes: Buffer.from([137, 80, 78, 71, 0, 255]),
    executable: false,
  },
  {
    path: "LICENSE.txt",
    bytes: Buffer.from("Synthetic license"),
    executable: false,
  },
];
async function fixture() {
  const base = path.resolve(".cache/skill-tests");
  await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, "run-"));
  const host = { id: "fixture", kind: "local" } as HostConfig;
  let downloads = 0;
  const options = {
    files: {
      skillLocations: async () => ({
        home,
        claudeConfig: path.join(home, ".claude"),
      }),
      editorSftp: async () => {
        throw new Error("No live SSH");
      },
    },
    download: async () => {
      downloads++;
      return payload;
    },
  };
  const library = new SkillLibrary(options);
  return { home, host, library, options, downloads: () => downloads };
}

test("catalog is pinned and all 19 skill trees are complete, bounded and portable", () => {
  assert.equal(source.commit, SKILL_SOURCE.commit);
  assert.equal(SKILL_CATALOG.length, 19);
  assert.equal(new Set(SKILL_CATALOG.map((s) => s.id)).size, 19);
  for (const skill of SKILL_CATALOG)
    assert.ok(
      validateSkillFiles(skill.id, source.files).some((f) =>
        f.path.endsWith("/SKILL.md"),
      ),
    );
  const file = {
    path: "skills/pdf/SKILL.md",
    mode: "100644",
    sha: "a".repeat(40),
    size: 1,
  };
  for (const bad of [
    "../outside",
    "x/../../escape",
    "C:ads",
    "folder\\file",
    "CON.txt",
    "tail.",
  ])
    assert.throws(() =>
      validateSkillFiles("pdf", [file, { ...file, path: `skills/pdf/${bad}` }]),
    );
  assert.throws(() => validateSkillFiles("pdf", [{ ...file, mode: "120000" }]));
  assert.throws(() =>
    validateSkillFiles("pdf", [{ ...file, size: 9 * 1024 * 1024 }]),
  );
  assert.throws(() =>
    validateSkillFiles("pdf", [file, { ...file, path: "skills/pdf/skill.md" }]),
  );
  assert.throws(() => validateSkillFiles("../pdf", [file]));
});

test("installation is per user, covers both providers/resources, preserves existing skills and never executes scripts", async () => {
  const { home, host, library, downloads } = await fixture();
  const initial = await library.status(host);
  assert.equal(initial.skills.pdf.claude, "available");
  assert.equal(initial.roots.codex, path.join(home, ".agents", "skills"));
  assert.deepEqual(
    await fs.readdir(home),
    [],
    "status does not create directories",
  );
  const results = await library.install(host, ["pdf"], ["claude", "codex"]);
  assert.deepEqual(
    results.map((r) => r.state),
    ["installed", "installed"],
  );
  assert.equal(downloads(), 1, "download once for both providers");
  for (const root of Object.values(initial.roots)) {
    for (const file of payload)
      assert.deepEqual(
        await fs.readFile(path.join(root, "pdf", file.path)),
        file.bytes,
      );
  }
  const status = await library.status(host);
  assert.deepEqual(status.skills.pdf, {
    claude: "installed",
    codex: "installed",
  });
  const original = path.join(initial.roots.claude, "pdf", "SKILL.md");
  await fs.writeFile(original, "User edit");
  assert.deepEqual(
    (await library.install(host, ["pdf"], ["claude", "codex"])).map(
      (r) => r.state,
    ),
    ["existing", "existing"],
  );
  assert.equal(await fs.readFile(original, "utf8"), "User edit");
  assert.equal(downloads(), 1);
});

test("SKILL.md appears atomically after resources and a failed publish rolls back only this installation", async () => {
  const { home } = await fixture(),
    io = skillTransport(),
    root = path.join(home, "skills");
  const writes: string[] = [];
  const tracked: SkillTransport = {
    ...io,
    async write(name, bytes, executable) {
      assert.equal(
        await io.stat(path.join(root, "pdf", "SKILL.md")),
        undefined,
      );
      writes.push(path.basename(name));
      await io.write(name, bytes, executable);
    },
  };
  await installSkill(tracked, root, "pdf", payload);
  assert.equal(writes.at(-1), ".harbor-SKILL.pending");
  const second = path.join(home, "failed");
  const failed: SkillTransport = {
    ...io,
    async publish(_temporary, filename) {
      await fs.writeFile(
        path.join(path.dirname(filename), "user-notes.txt"),
        "Keep me",
      );
      throw new Error("Synthetic disconnect");
    },
  };
  await assert.rejects(
    installSkill(failed, second, "pdf", payload),
    /Synthetic/,
  );
  assert.deepEqual(await fs.readdir(path.join(second, "pdf")), [
    "user-notes.txt",
  ]);
  assert.equal(
    await fs.readFile(path.join(second, "pdf", "user-notes.txt"), "utf8"),
    "Keep me",
  );
});

test("links, occupied files and concurrent provider failures cannot overwrite user content", async () => {
  const { home, host, options } = await fixture();
  const outside = path.join(home, "outside");
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(home, ".claude"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const library = new SkillLibrary(options);
  const status = await library.status(host);
  assert.equal(status.skills.pdf.claude, "unavailable");
  assert.equal(status.skills.pdf.codex, "available");
  assert.match(status.errors?.claude || "", /링크/);
  const results = await library.install(host, ["pdf"], ["claude", "codex"]);
  assert.equal(results[0].state, "error");
  assert.equal(results[1].state, "installed");
  assert.deepEqual(await fs.readdir(outside), []);
  const io = skillTransport(),
    root = path.join(home, "occupied");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "pdf"), "Existing file");
  assert.equal(await installSkill(io, root, "pdf", payload), "existing");
  assert.equal(
    await fs.readFile(path.join(root, "pdf"), "utf8"),
    "Existing file",
  );
  let unblock!: () => void;
  const paused = new SkillLibrary({
    ...options,
    download: async () => {
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      return payload;
    },
  });
  const install = paused.install(host, ["docx"], ["codex"]);
  while (!unblock) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(paused.install(host, ["docx"], ["codex"]), /설치하고/);
  unblock();
  await install;
});

test("a failed exclusive file create does not delete a concurrently added user file", async () => {
  const { home } = await fixture(),
    io = skillTransport(),
    root = path.join(home, "skills");
  const conflicting: SkillTransport = {
    ...io,
    async write(name, bytes, executable) {
      if (name.endsWith("tool.py"))
        await fs.writeFile(name, "Concurrent user file");
      await io.write(name, bytes, executable);
    },
  };
  await assert.rejects(installSkill(conflicting, root, "pdf", payload));
  assert.equal(
    await fs.readFile(path.join(root, "pdf", "scripts", "tool.py"), "utf8"),
    "Concurrent user file",
  );
  assert.equal(await io.stat(path.join(root, "pdf", "SKILL.md")), undefined);
});

test("downloads reject corruption, oversize bodies and HTTP failures before installation", async () => {
  for (const response of [
    () => new Response("corrupt"),
    () => new Response(Buffer.alloc(9 * 1024 * 1024)),
    () => new Response("", { status: 503 }),
  ]) {
    const urls: string[] = [];
    await assert.rejects(
      downloadSkill("pdf", (async (url: string) => {
        urls.push(url);
        return response();
      }) as typeof fetch),
    );
    assert.ok(urls.length <= 6);
    assert.ok(
      urls.every((url) =>
        url.startsWith(
          `https://raw.githubusercontent.com/anthropics/skills/${SKILL_SOURCE.commit}/`,
        ),
      ),
    );
  }
});

test("route validates targets and never accepts arbitrary repositories, paths or provider commands", async (t) => {
  const { library, host, home } = await fixture();
  let prepared = 0;
  const app = express();
  app.use(express.json());
  app.use(
    "/hosts",
    createSkillRouter(
      library,
      (id) => {
        if (id !== host.id) throw new Error("Unknown host");
        return host;
      },
      async () => {
        prepared++;
      },
    ),
  );
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(400).json({ error: error.message }),
  );
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as any).port}/hosts/fixture`;
  for (const body of [
    { ids: ["../pdf"], providers: ["codex"] },
    { ids: ["pdf"], providers: ["shell"] },
    { ids: ["pdf"], providers: ["codex"], path: home },
    { ids: [], providers: ["codex"] },
  ]) {
    assert.equal(
      (
        await fetch(`${base}/skills/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  }
  assert.equal(prepared, 0);
  const response = await fetch(`${base}/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["pdf"], providers: ["codex"] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].state, "installed");
  const status = await fetch(`${base}/skills`);
  assert.equal((await status.json()).skills.pdf.codex, "installed");
  assert.equal(prepared, 2);
});
