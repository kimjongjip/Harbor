import test from "node:test";
import assert from "node:assert/strict";
import {
  MobileSessionPreloader,
  mobileScreenKey,
  type MobilePreview,
} from "./mobile/session-preloader";
const identity = {
  runtimeId: "runtime",
  terminalId: "terminal",
  sessionId: "session",
};
const key = mobileScreenKey("runtime", "terminal", "session");
const preview: MobilePreview = {
  ...identity,
  data: "PREVIEW",
  replay: { cols: 80, rows: 24, resizes: [] },
};
test("preload hands off one in-flight read, rejects stale identities and cancels superseded work", async () => {
  const reads: {
    signal: AbortSignal;
    resolve: (value: MobilePreview) => void;
  }[] = [];
  const loader = new MobileSessionPreloader(
    (_identity, signal) =>
      new Promise((resolve) => reads.push({ signal, resolve })),
  );
  const first = loader.prepare(identity);
  assert.equal(loader.prepare(identity), first);
  assert.equal(reads.length, 1);
  const controller = new AbortController();
  const owned = loader.take(key, controller.signal);
  assert.ok(owned);
  reads[0].resolve(preview);
  assert.deepEqual(await owned, preview);
  const other = { ...identity, terminalId: "other" };
  const second = loader.prepare(other);
  const third = loader.prepare({ ...other, sessionId: "new" });
  assert.ok(reads[1].signal.aborted);
  reads[1].resolve({ ...preview, terminalId: "other" });
  reads[2].resolve({ ...preview, terminalId: "other" }); // old native session
  assert.equal(await second, undefined);
  assert.equal(await third, undefined);
  assert.equal(loader.prepare(other), undefined); // no focus-triggered retry storm
  loader.clear();
});
test("preload never returns a cancelled or expired view and handles read errors silently", async (t) => {
  let release!: (value: MobilePreview) => void;
  let signal!: AbortSignal;
  const loader = new MobileSessionPreloader((_identity, s) => {
    signal = s;
    return new Promise((r) => (release = r));
  });
  loader.prepare(identity);
  const controller = new AbortController(),
    result = loader.take(key, controller.signal);
  controller.abort();
  assert.ok(signal.aborted);
  release(preview);
  assert.equal(await result, undefined);
  loader.clear();
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  const pending = loader.prepare(identity);
  clock.mock.mockImplementation(() => now + 15001);
  assert.equal(loader.take(key, new AbortController().signal), undefined);
  assert.ok(signal.aborted);
  release(preview);
  assert.equal(await pending, undefined);
  const failed = new MobileSessionPreloader(async () => {
    throw new Error("offline");
  });
  assert.equal(await failed.prepare(identity), undefined);
  failed.clear();
  loader.clear();
});
