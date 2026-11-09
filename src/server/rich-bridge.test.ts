import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";
import type { TerminalInfo } from "../shared/types.js";

test("rich requests require the hook capability and exact current native conversation", async () => {
  const root = resolve(".cache/rich-bridge-tests");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "run-"));
  const terminals: TerminalInfo[] = [
    {
      id: "terminal",
      hostId: "fixture",
      title: "Fixture",
      cwd: "/fixture",
      exited: false,
      agentKind: "claude",
      agentSessionId: "native-1",
    },
  ];
  const mailbox = new Mailbox(folder, {
    terminal: (id) => terminals.find((t) => t.id === id),
    host: (id) => ({ id, name: "fixture" }),
  });
  let accepted = 0;
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: (id) => ({ id, name: "fixture" }),
    onRichRequest: async () => {
      accepted++;
      return { enabled: false };
    },
  });
  const issued = bridge.issue("terminal"),
    app = express();
  app.use("/bridge/rich", bridge.richHandle);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/bridge/rich`;
  const post = (token: string, sessionId = "native-1") =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(3000),
    });
  try {
    assert.equal((await post(issued.token)).status, 401);
    assert.equal(
      (await post(issued.hookToken, "different-native")).status,
      409,
    );
    assert.equal((await post(issued.hookToken)).status, 200);
    assert.equal(accepted, 1);
    // Recovery re-registers the identical capabilities without revoking live state.
    bridge.restore("terminal", issued);
    assert.equal((await post(issued.hookToken)).status, 200);
    assert.throws(() =>
      bridge.restore("terminal", { ...issued, token: "a".repeat(64) }),
    );
    terminals[0].exited = true;
    assert.equal((await post(issued.hookToken)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    assert.ok(resolve(folder).startsWith(root + sep));
    rmSync(folder, { recursive: true });
  }
});
