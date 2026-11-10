import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexUsageHistory,
  CodexUsageLedger,
  codexApiCost,
} from "./codex-usage-history.js";
const line = (v: unknown) => JSON.stringify(v) + "\n";
const model = (model: string) =>
  line({ type: "turn_context", payload: { model } });
const tokens = (input: number, cached: number, output: number, last = 40000) =>
  line({
    timestamp: "2026-11-10T01:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: 258400,
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: output / 2,
          total_tokens: input + output,
        },
        last_token_usage: { input_tokens: last - 1000, total_tokens: last },
      },
    },
  });

test("Codex USD uses each request model, cache discount, and deduplicated cumulative deltas", () => {
  const ledger = new CodexUsageLedger("a");
  const first = tokens(100000, 80000, 10000);
  ledger.append(model("gpt-6-astra") + first + first);
  assert.equal(ledger.snapshot()!.costUsd, 0.78);
  ledger.append(model("gpt-6.1-terra") + tokens(200000, 160000, 20000, 50000));
  assert.ok(Math.abs(ledger.snapshot()!.costUsd! - 0.854) < 1e-9);
  assert.equal(ledger.snapshot()!.usedTokens, 50000);
  assert.equal(
    ledger.snapshot()!.contextWindow,
    258400,
    "limit comes from Codex, not the price table",
  );
  ledger.append(line({ type: "compacted" }));
  assert.equal(ledger.snapshot()!.usedTokens, null);
  assert.ok(ledger.snapshot()!.costUsd! > 0);
  ledger.append(model("private-model") + tokens(210000, 160000, 21000));
  assert.equal(ledger.snapshot()!.costStatus, "partial");
});

test("API conversion includes long context and cache writes without double counting reasoning", () => {
  assert.equal(
    codexApiCost(
      "gpt-6-astra",
      { input: 300000, cached: 200000, write: 50000, output: 10000 },
      300000,
    ),
    3.4,
  );
  assert.equal(
    codexApiCost(
      "gpt-6.1-sol",
      { input: 300000, cached: 200000, write: 50000, output: 10000 },
      300000,
    ),
    0.64,
  );
  assert.equal(
    codexApiCost("unknown", { input: 1, cached: 0, write: 0, output: 1 }, 1),
    null,
  );
  assert.equal(
    codexApiCost(
      "gpt-6-astra",
      { input: 1, cached: 2, write: 0, output: 1 },
      1,
    ),
    null,
  );
});

test("bounded Codex scan advances incrementally, survives partial records, and resets on truncation", async () => {
  const store = new CodexUsageHistory();
  let content = Buffer.from(
    model("gpt-6-astra") + tokens(100000, 80000, 10000),
  );
  const offsets: number[] = [];
  const read = async (start: number) => {
    offsets.push(start);
    return {
      size: content.length,
      data: content.subarray(start, Math.min(content.length, start + 64)),
    };
  };
  const tail = async () => content.toString();
  let value = await store.read("h", "s", "/file", read, tail);
  while (value?.costStatus === "loading")
    value = await store.read("h", "s", "/file", read, tail);
  assert.equal(value!.costUsd, 0.78);
  const end = offsets.at(-1)!;
  content = Buffer.concat([
    content,
    Buffer.from(tokens(200000, 160000, 20000) + '{"type":"unfinished"'),
  ]);
  value = await store.read("h", "s", "/file", read, tail);
  while (value?.costStatus === "loading")
    value = await store.read("h", "s", "/file", read, tail);
  assert.equal(value!.costUsd, 1.56);
  assert.ok(offsets.at(-1)! > end);
  content = Buffer.from(model("gpt-6.1-terra") + tokens(10000, 0, 1000));
  value = await store.read("h", "s", "/file", read, tail);
  while (value?.costStatus === "loading")
    value = await store.read("h", "s", "/file", read, tail);
  assert.equal(value!.costUsd, 0.015);
  store.clear("h");
});

test("current context does not wait for the old cost scan, and closing the host cancels it", async () => {
  const store = new CodexUsageHistory();
  let release!: (chunk: { size: number; data: Buffer }) => void,
    reads = 0;
  const read = () => {
    reads++;
    return new Promise<{ size: number; data: Buffer }>((resolve) => {
      release = resolve;
    });
  };
  const value = await store.read("h", "s", "/file", read, async () =>
    tokens(100000, 80000, 10000),
  );
  assert.equal(value!.usedTokens, 40000);
  assert.equal(value!.contextWindow, 258400);
  assert.equal(value!.costStatus, "loading");
  assert.equal(value!.costUsd, null);
  store.clear("h");
  release({ size: 1000000, data: Buffer.from(model("gpt-6-astra")) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "cancelled sessions never continue scanning");
  store.shutdown();
});
