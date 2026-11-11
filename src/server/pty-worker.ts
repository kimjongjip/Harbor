import * as native from "node-pty";

// No HTTP server, credentials store or other sessions are loaded here. Native
// aborts take down only this terminal host, which the parent reports as exited.
let terminal: native.IPty | undefined;
let closing = false,
  ended = false,
  pending = 0,
  paused = false;
const stop = () => {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(0), 1500);
  deadline.unref();
  try {
    terminal?.kill();
  } catch {
    process.exit(1);
  }
  if (!terminal) process.exit(0);
};
const finish = (code: number, error?: string) => {
  if (ended) return;
  ended = true;
  if (!process.connected) process.exit(0);
  process.send?.(
    error ? { type: "error", error } : { type: "exit", code },
    () => process.exit(0),
  );
};
process.on("disconnect", stop);
process.on("message", (message: any) => {
  if (ended || !message || typeof message !== "object") return;
  try {
    if (message.type === "start" && !terminal && !closing) {
      terminal = native.spawn(message.file, message.args, message.options);
      terminal.onData((data) => {
        if (!process.connected || ended) return;
        pending++;
        const writable = process.send?.({ type: "data", data }, (error) => {
          pending--;
          if (error) {
            stop();
            return;
          }
          if (paused && pending === 0 && !ended && !closing) {
            paused = false;
            terminal?.resume();
          }
        });
        if (writable === false && !paused) {
          paused = true;
          terminal?.pause();
        }
      });
      terminal.onExit(({ exitCode }) => finish(exitCode));
      process.send?.({ type: "ready" });
    } else if (
      message.type === "write" &&
      !closing &&
      typeof message.data === "string"
    ) {
      terminal?.write(message.data);
    } else if (
      message.type === "resize" &&
      !closing &&
      Number.isInteger(message.cols) &&
      Number.isInteger(message.rows)
    ) {
      terminal?.resize(message.cols, message.rows);
    } else if (message.type === "close") stop();
  } catch (error) {
    // JS errors are reported without allowing a callback to escape through
    // the native addon. Native fail-fast exits are handled by the parent.
    finish(-1, (error as Error).message);
  }
});
