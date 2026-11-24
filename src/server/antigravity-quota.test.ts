import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAntigravityQuota,
  readQuotaConsole,
  type QuotaConsole,
} from "./antigravity-quota";

const quota = [
  "Models & Quota",
  "Account: quota@example.invalid",
  "GEMINI MODELS",
  "Weekly Limit Remaining",
  "[██░] 73.24%",
  "Refreshes in 1d 2h 30m",
  "Five Hour Limit Remaining",
  "[██] 100.00%",
  "Quota available",
  "CLAUDE AND GPT MODELS",
  "Weekly Limit Remaining",
  "[█░] 2.00%",
  "Five Hour Limit Remaining",
  "[░] 0.00%",
  "esc Close",
].join("\n");
test("actual /usage panel retains independent provider groups, exact remaining percentages and only reported reset times", () => {
  const q = parseAntigravityQuota(quota, 1000)!;
  assert.equal(q.account, "quota@example.invalid");
  assert.deepEqual(
    q.windows.map((w) => [w.label, w.remaining]),
    [
      ["Gemini · 7일", 73.24],
      ["Gemini · 5시간", 100],
      ["Claude · GPT · 7일", 2],
      ["Claude · GPT · 5시간", 0],
    ],
  );
  assert.equal(q.windows[0].resetsAt, 1000 + (24 * 60 + 2 * 60 + 30) * 60000);
  assert.equal(q.windows[1].resetsAt, undefined);
  assert.equal(parseAntigravityQuota("context remaining: 80%"), undefined);
});
function simulated(trusted: boolean, validMenu: boolean) {
  const writes: string[] = [];
  let close = false;
  let data: (s: string) => void, exit: () => void;
  const cwd = "/fake-home/.cache/harbor/agy-quota-view";
  const show = (s: string) =>
    setImmediate(() => data("\x1b[2J\x1b[H" + s.replaceAll("\n", "\r\n")));
  const transport: QuotaConsole = {
    cwd,
    ownedEmpty: async () => trusted,
    onData: (f) => {
      data = f;
      show(
        "Accessing workspace:\n" +
          cwd +
          "\nDo you trust the contents of this project?\n> Yes, I trust this folder",
      );
    },
    onExit: (f) => {
      exit = f;
    },
    close: () => {
      close = true;
    },
    write: (s) => {
      writes.push(s);
      if (writes.length === 1) show("Antigravity CLI 1.5.15\n>");
      else if (s === "/usage") {
        show(
          validMenu
            ? "> /usage  View model quota usage"
            : "Please sign in\n> /usage",
        );
        if (!validMenu) setTimeout(() => exit(), 25);
      } else show(quota);
    },
  };
  return { transport, writes, closed: () => close };
}
test("confirms only the empty quota workspace and selects the locally declared built-in menu, never submits an unknown command", async () => {
  const good = simulated(true, true);
  await readQuotaConsole(good.transport);
  assert.deepEqual(good.writes, ["\r", "/usage", "\r"]);
  assert.ok(good.closed());
  const other = simulated(false, true);
  await assert.rejects(readQuotaConsole(other.transport));
  assert.deepEqual(other.writes, []);
  const unknown = simulated(true, false);
  await assert.rejects(readQuotaConsole(unknown.transport));
  assert.deepEqual(unknown.writes, ["\r", "/usage"]);
  assert.ok(unknown.closed());
});
