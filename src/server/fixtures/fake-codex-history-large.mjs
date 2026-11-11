import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const message = JSON.parse(line),
    p = message.params;
  if (message.method === "initialize")
    send({ id: message.id, result: { userAgent: "history-fixture" } });
  else if (message.method === "thread/read")
    send({
      id: message.id,
      result: { thread: { id: "fixture-thread", cwd: "/fixture" } },
    });
  else if (message.method === "thread/turns/list") {
    const offset = Number(p.cursor || 0),
      count = Math.min(p.limit, 6 - offset);
    const data = Array.from({ length: count }, (_, i) => {
      const n = 5 - offset - i;
      return {
        id: "turn-" + n,
        status: "completed",
        items: [
          {
            id: "q-" + n,
            type: "userMessage",
            content: [{ type: "text", text: "Question " + n }],
          },
          {
            id: "work-" + n,
            type: "mcpToolCall",
            server: "fixture",
            tool: "read",
            status: "completed",
            result: {
              content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
            },
          },
          {
            id: "a-" + n,
            type: "agentMessage",
            phase: "final_answer",
            text: "Answer " + n,
          },
        ],
      };
    });
    send({
      id: message.id,
      result: {
        data,
        nextCursor: offset + count < 6 ? String(offset + count) : null,
      },
    });
  } else if (message.id !== undefined)
    send({
      id: message.id,
      error: { code: -32601, message: "Read-only fixture" },
    });
});
