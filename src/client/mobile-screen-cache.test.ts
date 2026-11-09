import test from "node:test";
import assert from "node:assert/strict";
import { MobileScreenCache } from "./mobile/screen-cache";
test("mobile preview cache is isolated by caller identity and replays data/resize in order", () => {
  const cache = new MobileScreenCache();
  const key = JSON.stringify(["runtime", "terminal", "conversation"]);
  cache.snapshot(key, "initial", {
    cols: 100,
    rows: 30,
    resizes: [],
    snapshot: true,
  });
  cache.append(key, "later");
  cache.resize(key, 120, 40);
  cache.append(key, "end");
  const result = cache.get(key)!;
  assert.equal(result.data, "initiallaterend");
  assert.deepEqual(result.replay!.resizes, [
    { offset: 12, cols: 120, rows: 40 },
  ]);
  result.replay!.resizes.length = 0;
  assert.equal(cache.get(key)!.replay!.resizes.length, 1);
  assert.equal(
    cache.get(JSON.stringify(["new-runtime", "terminal", "conversation"])),
    undefined,
  );
  assert.equal(
    cache.get(JSON.stringify(["runtime", "terminal", "new-conversation"])),
    undefined,
  );
  cache.clear();
  assert.equal(cache.get(key), undefined);
});
test("mobile preview cache evicts by byte budget and least recently used session", () => {
  const cache = new MobileScreenCache(2, 100);
  cache.snapshot("a", "first");
  cache.snapshot("b", "second");
  cache.get("a");
  cache.snapshot("c", "third");
  assert.equal(cache.get("b"), undefined);
  assert.ok(cache.get("a"));
  cache.snapshot("big", "x".repeat(100));
  assert.equal(cache.get("big"), undefined);
  cache.append("missing", "not a snapshot");
  assert.equal(cache.get("missing"), undefined);
});
