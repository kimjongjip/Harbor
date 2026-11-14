import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";

export type LocalPty = Pick<
  IPty,
  "write" | "resize" | "kill" | "onData" | "onExit"
> & { readonly monitorPid?: number };

/** Native ConPTY failures cannot be caught by JS. Keep one terminal's native
 * handles in an owned process, outside the HTTP server and other terminals. */
export function spawnLocalPty(
  file: string,
  args: string[],
  options: IPtyForkOptions & IWindowsPtyForkOptions,
  worker = new URL(
    existsSync(new URL("./pty-worker.mjs", import.meta.url))
      ? "./pty-worker.mjs"
      : "./pty-worker.ts",
    import.meta.url,
  ),
): Promise<LocalPty> {
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const events = new EventEmitter();
    let ready = false,
      ended = false,
      closing = false,
      exitCode: number | undefined,
      queued: string[] = [],
      closeTimer: ReturnType<typeof setTimeout> | undefined;
    const startup = setTimeout(() => {
      finish(-1, "터미널 호스트 시작 시간이 초과됐습니다.");
      child.kill(); // Only this newly created worker; never the backend/CLI reader.
    }, 15000);
    const finish = (code: number, error?: string) => {
      if (ended) return;
      ended = true;
      exitCode = code;
      clearTimeout(startup);
      clearTimeout(closeTimer);
      if (!ready)
        reject(new Error(error || `터미널 호스트가 종료됐습니다 (${code}).`));
      events.emit("exit", { exitCode: code });
    };
    const send = (message: unknown) => {
      if (ended || !child.connected) return;
      child.send(message as object, (error) => {
        if (error) finish(-1, "터미널 호스트 연결이 끊겼습니다.");
      });
    };
    const pty: LocalPty = {
      monitorPid: child.pid,
      write: (data) => {
        if (!closing) send({ type: "write", data });
      },
      resize: (cols, rows) => {
        if (!closing) send({ type: "resize", cols, rows });
      },
      kill: () => {
        if (closing || ended) return;
        closing = true;
        send({ type: "close" });
        closeTimer = setTimeout(() => child.kill(), 3000);
        closeTimer.unref();
      },
      onData: (listener) => {
        events.on("data", listener);
        const pending = queued;
        queued = [];
        for (const data of pending) listener(data);
        return { dispose: () => events.off("data", listener) };
      },
      onExit: (listener) => {
        events.on("exit", listener);
        if (exitCode !== undefined) listener({ exitCode });
        return { dispose: () => events.off("exit", listener) };
      },
    };
    child.on("message", (message: any) => {
      if (ended || !message || typeof message !== "object") return;
      if (message.type === "ready") {
        clearTimeout(startup);
        ready = true;
        resolve(pty);
      } else if (message.type === "data" && typeof message.data === "string") {
        if (events.listenerCount("data")) events.emit("data", message.data);
        else queued.push(message.data);
      } else if (message.type === "exit") finish(message.code);
      else if (message.type === "error") finish(-1, String(message.error));
    });
    child.once("error", (error) => finish(-1, error.message));
    child.once("exit", (code) => finish(code ?? -1));
    send({ type: "start", file, args, options });
  });
}
