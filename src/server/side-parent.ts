import { randomBytes } from "node:crypto";
import express from "express";
import type { IdeChatConversation } from "../shared/ide-chat.js";

export interface SideReader {
  url: string;
  token: string;
  release(): void;
}
export class SideParentReaders {
  private readonly readers = new Map<
    string,
    () => Promise<IdeChatConversation>
  >();
  readonly router = express.Router();
  constructor() {
    this.router.post("/", express.json({ limit: "32kb" }), async (req, res) => {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(
        req.header("authorization") || "",
      )?.[1];
      const read = token && this.readers.get(token);
      if (
        !read ||
        req.headers.origin ||
        !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")
      ) {
        res.sendStatus(403);
        return;
      }
      const { id, method, params } = req.body || {};
      res.set("Cache-Control", "no-store");
      if (id === undefined) {
        res.sendStatus(202);
        return;
      }
      const reply = (result: unknown) =>
        res.json({ jsonrpc: "2.0", id, result });
      if (method === "initialize") {
        reply({
          protocolVersion: params?.protocolVersion || "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "Harbor side chat", version: "1" },
        });
        return;
      }
      if (method === "ping") {
        reply({});
        return;
      }
      if (method === "tools/list") {
        reply({
          tools: [
            {
              name: "read_parent",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              description:
                "Read current public messages, commands and outputs from this side chat's parent. Optionally search for a filename or error.",
              inputSchema: {
                type: "object",
                properties: { search: { type: "string", maxLength: 200 } },
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      }
      if (method !== "tools/call" || params?.name !== "read_parent") {
        res.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Unknown method or tool" },
        });
        return;
      }
      const args = params.arguments ?? {};
      const search = args.search ?? "";
      if (
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).some((k) => k !== "search") ||
        typeof search !== "string" ||
        search.length > 200
      ) {
        res.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid search" },
        });
        return;
      }
      try {
        const parent = await read();
        const rows = parent.items
          .filter((i) =>
            [i.text, i.detail].some((value) =>
              value?.toLowerCase().includes(search.toLowerCase()),
            ),
          )
          .slice(-32);
        const text = rows
          .map((i) =>
            [i.kind, i.status, i.text.slice(0, 1600), i.detail?.slice(-3000)]
              .filter(Boolean)
              .join(" · "),
          )
          .join("\n")
          .slice(-24000);
        reply({
          content: [{ type: "text", text: parent.status + "\n" + text }],
        });
      } catch {
        reply({
          isError: true,
          content: [{ type: "text", text: "Parent conversation unavailable." }],
        });
      }
    });
    this.router.all("/", (_req, res) => {
      res.set("Allow", "POST").sendStatus(405);
    });
  }
  issue(port: number, read: () => Promise<IdeChatConversation>): SideReader {
    const token = randomBytes(32).toString("hex");
    this.readers.set(token, read);
    return {
      url: "http://127.0.0.1:" + port + "/bridge/side-parent",
      token,
      release: () => this.readers.delete(token),
    };
  }
}
