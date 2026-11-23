import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { LabQuestions, type LabRunner } from "./lab-questions";
import { readAcpAnswer } from "./lab-gemini";
import { relayChatRequest } from "./workspace-chat";
import type { LabMember, LabQuestionInput } from "../shared/lab-question";

const input = (): LabQuestionInput => ({
  requestId: randomUUID(),
  question: "Compare measurements",
  material: "Shared table",
  debate: true,
  chair: 0,
  members: [
    { provider: "codex", hostId: "local" },
    { provider: "claude", hostId: "remote" },
    { provider: "antigravity", hostId: "remote", model: "gemini-test" },
  ],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a durable workspace owns all selected members and a relay cannot target another server", () => {
  const members = input().members.map((m) => ({ ...m, hostId: "fixture" }));
  const form = { ...input(), members },
    options = { method: "POST", path: "/lab-questions", query: {}, body: form };
  const mapped = relayChatRequest("fixture", options);
  assert.equal(mapped.path, "/lab-questions");
  assert.deepEqual(
    mapped.body.members.map((m: LabMember) => m.hostId),
    ["local", "local", "local"],
  );
  assert.throws(() => relayChatRequest("other", options));
  assert.throws(() =>
    relayChatRequest("fixture", {
      ...options,
      path: "/lab-questions/../../settings",
    }),
  );
});

test("parallel independent answers, review barrier, one synthesis; duplicate request is inert", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-question-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: { provider: string; prompt: string; ok: (s: string) => void }[] =
    [];
  const run: LabRunner = (m, p) =>
    new Promise((ok) => calls.push({ provider: m.provider, prompt: p, ok }));
  const service = new LabQuestions(dir, run, (m) => m.hostId);
  const data = input(),
    job = service.create(data);
  assert.equal(service.create(data).id, job.id);
  assert.throws(() => service.create({ ...data, material: "other" }));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.prompt)).size, 1);
  calls[2].ok("Google answer");
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(service.get(job.id).answers[2].text, "Google answer");
  calls[0].ok("OpenAI answer");
  calls[1].ok("Anthropic answer");
  await tick();
  assert.equal(calls.length, 6);
  assert.ok(
    calls
      .slice(3)
      .every(
        (c) =>
          c.prompt.includes("Google answer") &&
          c.prompt.includes("OpenAI answer"),
      ),
  );
  calls.slice(3).forEach((c) => c.ok("Review by " + c.provider));
  await tick();
  assert.equal(calls.length, 7);
  assert.equal(calls[6].provider, "codex");
  calls[6].ok("Conclusion");
  await tick();
  const reopened = new LabQuestions(dir, run, (m) => m.hostId);
  assert.equal(reopened.get(job.id).conclusion[0].text, "Conclusion");
  assert.equal(calls.length, 7);
});

test("partial results allow survivor discussion, canceled work stays stopped, explicit retry preserves successes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-question-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pending: {
    ok: (s: string) => void;
    fail: (e: Error) => void;
    signal: AbortSignal;
  }[] = [];
  const run: LabRunner = (_m, _p, signal) =>
    new Promise((ok, fail) => pending.push({ ok, fail, signal }));
  const service = new LabQuestions(dir, run, (m) => m.hostId);
  const data = input();
  data.chair = 2;
  const job = service.create(data);
  pending[0].ok("A");
  pending[1].ok("B");
  pending[2].fail(Error("quota"));
  await tick();
  assert.equal(service.get(job.id).status, "partial");
  service.control(job.id, "review");
  assert.equal(pending.length, 5);
  pending[3].ok("rA");
  await tick();
  service.control(job.id, "cancel");
  assert.equal(pending[4].signal.aborted, true);
  pending[4].ok("late");
  await tick();
  assert.equal(service.get(job.id).reviews[1].text, undefined);
  assert.equal(pending.length, 5);
  const reopened = new LabQuestions(dir, run, (m) => m.hostId);
  reopened.control(job.id, "retry");
  pending[5].ok("rB");
  await tick();
  assert.equal(pending.length, 6);
  reopened.control(job.id, "conclude", 1);
  pending[6].ok("done");
  await tick();
  assert.equal(reopened.get(job.id).chair, 1);
  assert.equal(reopened.get(job.id).answers[2].error, "quota");
});

test("ACP reviewer selects and confirms Gemini, rejects permission, collects only matching-session text", async () => {
  const input = new PassThrough(),
    out = new PassThrough();
  const lines = createInterface({ input: out });
  let permission: any;
  const respond = (m: unknown) => input.write(JSON.stringify(m) + "\n");
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id === 99) {
      permission = m.result.outcome;
      return;
    }
    switch (m.method) {
      case "initialize":
        respond({ id: m.id, result: { protocolVersion: 1 } });
        break;
      case "session/new":
        respond({
          id: m.id,
          result: {
            sessionId: "fixture",
            configOptions: [
              {
                id: "model",
                currentValue: "claude-x",
                options: [{ value: "gemini-x" }],
              },
            ],
          },
        });
        break;
      case "session/set_config_option":
        assert.equal(m.params.value, "gemini-x-low");
        respond({
          id: m.id,
          result: {
            configOptions: [
              { id: "model", currentValue: "gemini-x" },
              { id: "thought_level", currentValue: "low" },
            ],
          },
        });
        break;
      case "session/prompt":
        respond({
          id: 99,
          method: "session/request_permission",
          params: { sessionId: "fixture" },
        });
        for (const sessionId of ["wrong", "fixture"])
          respond({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: sessionId },
              },
            },
          });
        respond({ id: m.id, result: { stopReason: "end_turn" } });
        break;
    }
  });
  try {
    assert.equal(
      await readAcpAnswer(
        input,
        out,
        "/project",
        "gemini-x-low",
        "review",
        new AbortController().signal,
      ),
      "fixture",
    );
    assert.deepEqual(permission, { outcome: "cancelled" });
  } finally {
    lines.close();
    input.destroy();
    out.destroy();
  }
});
