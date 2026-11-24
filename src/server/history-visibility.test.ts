import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostConfig } from "../shared/types.js";
import type { HistoryThread } from "../shared/history.js";
import {
  HistoryVisibility,
  verificationHistoryKey,
  visibleHistoryPage,
} from "./history-visibility.js";

test("verification history exclusions match only the recorded provider, account and native ID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harbor-history-filter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = {
    kind: "ssh",
    id: "fixture",
    address: "fixture.example",
    port: 22,
    username: "one",
    identityFile: "",
  } as HostConfig;
  const file = join(directory, "hidden-verification-history.json");
  const id = "test-thread";
  assert.equal(
    new HistoryVisibility(directory).visible(host, "codex", id),
    true,
  );
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      records: [verificationHistoryKey(host, "codex", id)],
    }),
  );
  const visibility = new HistoryVisibility(directory);
  assert.equal(visibility.visible(host, "codex", id), false);
  assert.equal(visibility.visible(host, "claude", id), true);
  assert.equal(
    visibility.visible({ ...host, username: "two" }, "codex", id),
    true,
  );
  assert.equal(visibility.visible(host, "codex", "other-test-thread"), true);
  await writeFile(file, "invalid");
  assert.equal(
    new HistoryVisibility(directory).visible(host, "codex", id),
    true,
  );
});

test("an excluded whole page does not hide later searchable records or lose the continuation cursor", async () => {
  const row = (id: string) =>
    ({ id, title: "test", cwd: "/project/test" }) as HistoryThread;
  const seen: Array<string | undefined> = [];
  const page = await visibleHistoryPage(
    undefined,
    async (cursor) => {
      seen.push(cursor);
      return cursor
        ? { data: [row("normal")], nextCursor: "more" }
        : { data: [row("known-fixture")], nextCursor: "next" };
    },
    (r) => r.id !== "known-fixture",
  );
  assert.deepEqual(seen, [undefined, "next"]);
  assert.equal(page.data[0].id, "normal");
  assert.equal(page.nextCursor, "more");
  await assert.rejects(
    visibleHistoryPage(
      "again",
      async () => ({ data: [row("hidden")], nextCursor: "again" }),
      () => false,
    ),
  );
});
