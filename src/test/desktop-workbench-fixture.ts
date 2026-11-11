import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopAccess } from "../server/desktop-access";
import { EditorFiles, createEditorRouter } from "../server/editor-files";
import { Files } from "../server/files";
import { sendMediaFile } from "../server/file-media";
import { mobileFixture } from "./mobile-fixture";
import type { HostConfig } from "../shared/types";
import type { DesktopWorkspace } from "../shared/desktop-workspace";

export async function desktopWorkbenchFixture() {
  const f = await mobileFixture();
  const directory = join(f.directory, "project");
  await mkdir(directory);
  await writeFile(
    join(directory, "note.md"),
    "# Shared workbench\n\nThis is the same workspace.\n",
  );
  await writeFile(
    join(directory, "sample.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1x8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const content = "BT /F1 24 Tf 50 740 Td (REMOTE PDF VERIFIED) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [i, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(join(directory, "sample.pdf"), pdf);
  const host = {
    id: "fixture",
    name: "Shared server",
    kind: "local",
    address: "",
    username: "",
    port: 22,
    identityFile: "",
    codexPath: "codex",
    defaultCwd: directory,
    mode: "auto",
    color: "#3867d6",
    createdAt: 1,
    status: "connected",
    models: [],
  };
  Object.assign(f.state.terminals[0], {
    cwd: directory,
    agentConnected: true,
    integration: "unavailable",
  });
  const second = {
    ...f.state.terminals[0],
    id: randomUUID(),
    title: "Selected on host",
  };
  f.state.terminals.push(second);
  const state = {
    hosts: [host],
    terminals: f.state.terminals,
    sessions: [],
    activities: [],
    transfers: [],
    discussions: [],
    notices: [],
    mailbox: [],
    requests: [],
    researchLabs: [],
    connections: [],
  };
  const workspace: DesktopWorkspace = {
    activeId: second.id,
    page: "terminals",
    workspaceView: "terminal",
    sidebar: "servers",
    sidebarVisible: true,
    preferences: {
      "harbor.theme": "midnight",
      "harbor.sidebarWidth": "300",
      "harbor.usagePanelWidth": "320",
      "harbor.crewAppearance": JSON.stringify({
        character: "cat",
        scale: 1,
        animated: true,
      }),
    },
  };
  const desktop = new DesktopAccess(
    () => f.access,
    () => f.gateway.controls,
  );
  const files = new Files(() => undefined);
  files.resolvePath = async (_host, path) => (path === "~" ? directory : path);
  const editor = new EditorFiles({
    files,
    terminal: (id) => state.terminals.find((t) => t.id === id),
    host: () => host as HostConfig,
  });
  const app = express(),
    sockets = new WebSocketServer({ noServer: true });
  const inputs: string[] = [],
    subscriptions = new Map<WebSocket, Set<string>>();
  let deferred: (() => void) | undefined;
  app.use(express.json({ limit: "30mb" }));
  app.get("/api/bootstrap", (_req, res) =>
    res.json({
      token: "desktop",
      state,
      workspace,
      sshAliases: [],
      localCwd: directory,
      credentialStorageAvailable: false,
      capabilities: {
        terminalReplayState: true,
        terminalInputOptimized: true,
        terminalColors: true,
        claudeIntegration: true,
      },
    }),
  );
  app.get("/api/terminals/:id/rich", (_req, res) => res.json({ blocks: [] }));
  app.get("/api/terminals/:id/usage", (_req, res) =>
    res.json({
      usage: {
        provider: "codex",
        sessionId: "native-fixture",
        usedTokens: 51000,
        contextWindow: 1000000,
        usedPercent: 5.1,
        costUsd: 47.8,
        source: "native",
        updatedAt: Date.now(),
        agents: [],
      },
    }),
  );
  app.get("/api/terminals/:id/control", (req, res) =>
    res.json({ control: f.gateway.controls.view(req.params.id) }),
  );
  app.post("/api/terminals/:id/control", (req, res) => {
    const d = desktop.device(req)!;
    res.json(f.gateway.controls.change(req.params.id, d.id, d.name, req.body));
  });
  app.get("/api/hosts/:id/history/:session", (req, res) =>
    res.json({
      thread: { id: req.params.session, hostId: host.id, cwd: directory },
      items: [],
      timeline: [],
      nextCursor: null,
    }),
  );
  app.use(
    "/api/editor",
    createEditorRouter(editor, {
      authorize: (req, id, write) => desktop.authorize(req, id, write),
    }),
  );
  app.get("/api/hosts/:id/files", async (req, res) =>
    res.json(
      await files.list(host as HostConfig, String(req.query.path || directory)),
    ),
  );
  app.get("/api/hosts/:id/files/image", async (req, res) =>
    sendMediaFile(
      req,
      res,
      await files.image(host as HostConfig, String(req.query.path)),
    ),
  );
  app.get("/api/hosts/:id/files/pdf", async (req, res) =>
    sendMediaFile(
      req,
      res,
      await files.pdf(host as HostConfig, String(req.query.path)),
    ),
  );
  app.get("/api/deferred", async (_req, res) => {
    await new Promise<void>((r) => {
      deferred = r;
    });
    res.json({ secret: "pending document" });
  });
  app.use("/api", (_req, res) =>
    res.json({ data: [], messages: [], requests: [] }),
  );
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status || 400).json({ error: error.message }),
  );
  f.operations.desktop = {
    http: desktop.http(app),
    revoke: (id) => desktop.revoke(id),
    upgrade: (req, socket, head) => {
      desktop.upgrade(req);
      sockets.handleUpgrade(req, socket, head, (ws) => {
        desktop.socket(req, ws);
        subscriptions.set(ws, new Set());
        ws.on("close", () => subscriptions.delete(ws));
        ws.send(JSON.stringify({ type: "state", state }));
        ws.on("message", async (raw) => {
          if (!desktop.validSocket(ws)) return;
          try {
            const m = JSON.parse(String(raw));
            if (m.type === "subscribe") {
              subscriptions.set(ws, new Set(m.terminals));
              for (const id of m.terminals) {
                const snapshot = await f.screen.snapshot();
                if (desktop.validSocket(ws) && ws.readyState === WebSocket.OPEN)
                  ws.send(
                    JSON.stringify({ type: "terminal-data", id, ...snapshot }),
                  );
              }
            } else if (m.type === "terminal-input") {
              desktop.assert(req, m.id, m.clientId, m.controlToken);
              inputs.push(m.data);
              f.screen.append(m.data);
              for (const [client, ids] of subscriptions)
                if (ids.has(m.id) && desktop.validSocket(client))
                  client.send(
                    JSON.stringify({
                      type: "terminal-data",
                      id: m.id,
                      data: m.data,
                    }),
                  );
            }
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: (error as Error).message,
              }),
            );
          }
        });
      });
    },
  };
  async function pair(kind: "desktop" | "mobile" = "desktop") {
    const invite = f.access.pairing(kind),
      code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
        "pair",
      )!;
    const value = f.access.pair(code, `Fixture ${kind}`);
    return { cookie: `harbor_mobile=${value.token}`, id: value.device.id };
  }
  return {
    ...f,
    state,
    workspace,
    directory,
    second,
    inputs,
    pair,
    desktop,
    resizeScreen(cols: number, rows: number) {
      f.screen.resize(cols, rows);
      for (const [client, ids] of subscriptions)
        if (desktop.validSocket(client))
          for (const id of ids)
            client.send(
              JSON.stringify({ type: "terminal-resize", id, cols, rows }),
            );
    },
    deferred: () => deferred,
    close: async () => {
      for (const s of sockets.clients) s.terminate();
      sockets.close();
      await f.close();
    },
  };
}
