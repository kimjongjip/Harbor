import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Credentials } from "./credentials.js";
import type { HostConfig } from "../shared/types.js";

test(
  "DPAPI credentials survive restart, bind to a target, and never persist cleartext",
  { skip: process.platform !== "win32" },
  async (t) => {
    const parent = resolve(".cache/credential-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-"));
    t.after(async () => {
      if (resolve(directory).startsWith(parent + sep))
        await rm(directory, { recursive: true, force: true });
    });
    const host = {
      id: "fixture-one",
      kind: "ssh",
      address: "test.example",
      username: "test-user",
      port: 22,
    } as HostConfig;
    const other = { ...host, id: "fixture-two", port: 2200 };
    const firstPassword = `Synthetic_${randomUUID()}_한국어!`;
    const secondPassword = `Synthetic_${randomUUID()}`;
    const vault = new Credentials(directory);
    assert.equal(vault.has(host), false);
    await Promise.all([
      vault.set(host, firstPassword),
      vault.set(other, secondPassword),
    ]);
    const content = await readFile(vault.file, "utf8");
    assert.equal(content.includes(firstPassword), false);
    assert.equal(
      content.includes(Buffer.from(firstPassword).toString("base64")),
      false,
    );
    const reopened = new Credentials(directory);
    assert.equal(await reopened.get(host), firstPassword);
    assert.equal(await reopened.get(other), secondPassword);
    assert.equal(
      reopened.has({ ...host, address: "different.example" }),
      false,
    );
    assert.equal(
      await reopened.get({ ...host, username: "different-user" }),
      undefined,
    );
    await assert.rejects(reopened.set(host, ""), /비밀번호/);
    assert.equal(await reopened.get(host), firstPassword);
    await reopened.remove(host.id);
    assert.equal(new Credentials(directory).has(host), false);
    assert.equal(await reopened.get(other), secondPassword);
  },
);
