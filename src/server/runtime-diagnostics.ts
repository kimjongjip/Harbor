import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freemem } from "node:os";

/** Bounded numeric diagnostics. Never serialize an Error, environment, argv or user content. */
export function startRuntimeDiagnostics(directory: string) {
  const file = join(directory, "runtime-events.jsonl");
  const record = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      const memory = process.memoryUsage();
      try {
        if (statSync(file).size > 256 * 1024)
          writeFileSync(file, "", { mode: 0o600 });
      } catch {}
      appendFileSync(
        file,
        JSON.stringify({
          at: Date.now(),
          event,
          pid: process.pid,
          uptimeMs: Math.round(process.uptime() * 1000),
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
          available: freemem(),
          ...fields,
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostics must not interrupt the backend. */
    }
  };
  record("start");
  const timer = setInterval(() => record("sample"), 30000);
  timer.unref();
  const fatal = (error: Error, origin: string) => {
    const name = [
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "URIError",
      "EvalError",
    ].includes(error?.name)
      ? error.name
      : "Error";
    record("fatal", {
      name,
      origin:
        origin === "unhandledRejection"
          ? "unhandledRejection"
          : "uncaughtException",
      frames:
        error?.stack
          ?.match(/(?:server\.mjs|node:[a-zA-Z_\/-]+):\d+:\d+/g)
          ?.slice(0, 12) || [],
    });
  };
  const exit = (code: number) => record("exit", { code });
  process.on("uncaughtExceptionMonitor", fatal);
  process.on("exit", exit);
  return {
    shutdown(reason: "signal-int" | "signal-term" | "desktop-request") {
      clearInterval(timer);
      record("shutdown", { reason });
    },
    dispose() {
      clearInterval(timer);
      process.off("uncaughtExceptionMonitor", fatal);
      process.off("exit", exit);
    },
  };
}
