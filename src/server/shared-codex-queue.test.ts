import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import type { MailboxMessage } from "../shared/mailbox";
import { queueSharedCodexMessages } from "./shared-codex-queue";

test("shared delivery addresses only the loaded thread and distinguishes rejection from a lost receipt", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  let state = "notLoaded",
    outcome = "ok",
    reserved = 0,
    accepted = 0,
    rejected = 0;
  const calls: string[] = [];
  server.on("connection", (ws) =>
    ws.on("message", (b) => {
      const req = JSON.parse(b.toString());
      if (!req.id) return;
      calls.push(req.method);
      let result = {};
      if (req.method === "thread/read")
        result = { thread: { id: sessionId, status: { type: state } } };
      if (req.method === "thread/queue/add") {
        assert.equal(req.params.threadId, sessionId);
        assert.equal(req.params.clientUserMessageId, "harbor-peer-msg");
        if (outcome === "drop") {
          ws.terminate();
          return;
        }
        if (outcome === "reject") {
          ws.send(
            JSON.stringify({
              id: req.id,
              error: { code: -32601, message: "unsupported" },
            }),
          );
          return;
        }
        result = { queuedSubmission: { id: "native-fixture" } };
      }
      ws.send(JSON.stringify({ id: req.id, result }));
    }),
  );
  const message = {
    id: "msg",
    recipient: { sessionId },
    sender: { title: "fixture" },
    text: "fixture",
  } as MailboxMessage;
  const deliver = () =>
    queueSharedCodexMessages({
      sessionId,
      messages: [
        { ...message, recipient: { ...message.recipient, sessionId: "other" } },
        message,
      ],
      connect: async () => {
        const socket = connect(addr.port, "127.0.0.1");
        await once(socket, "connect");
        return socket;
      },
      reserve: () => {
        reserved++;
        return true;
      },
      accepted: () => {
        accepted++;
      },
      rejected: () => {
        rejected++;
      },
    });
  await assert.rejects(deliver);
  assert.deepEqual([reserved, accepted, rejected], [0, 0, 0]);
  state = "idle";
  await deliver();
  assert.deepEqual([reserved, accepted, rejected], [1, 1, 0]);
  state = "active";
  outcome = "reject";
  await assert.rejects(deliver);
  assert.deepEqual([reserved, accepted, rejected], [2, 1, 1]);
  outcome = "drop";
  await assert.rejects(deliver);
  assert.deepEqual([reserved, accepted, rejected], [3, 1, 1]);
  assert.ok(
    calls.every((c) =>
      ["initialize", "thread/read", "thread/queue/add"].includes(c),
    ),
  );
});
