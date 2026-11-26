import express from "express";
import type { AgentBridge } from "./agent-bridge.js";

/** The exact restricted listener forwarded over SSH; no bootstrap or UI routes. */
export function createBridgeRouter(bridge: AgentBridge) {
  const app = express();
  app.disable("x-powered-by");
  app.all("/bridge/mcp", bridge.handle);
  app.all("/bridge/permission", bridge.permissionHandle);
  app.use("/bridge/claude", bridge.claudeHandle);
  app.all("/bridge/annotation", bridge.annotationHandle);
  app.use("/bridge/peers", bridge.peerHandle);
  app.all("/bridge/rich", bridge.richHandle);
  app.use((_req, res) => res.sendStatus(404));
  return app;
}
