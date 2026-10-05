import type { IBuffer } from "@xterm/xterm";

export interface ComposerSnapshot {
  text: string;
  images: number;
}

/** Read only the prompt containing the live cursor, never scrollback/history. */
export function terminalComposer(buffer: IBuffer): ComposerSnapshot | null {
  const cursor = buffer.baseY + buffer.cursorY;
  let text = "";
  for (let row = cursor; row >= buffer.baseY; row--) {
    const value = buffer.getLine(row)?.translateToString(true) || "";
    // A blank separator means a previous prompt belongs to history. A draft
    // containing a blank line is conservatively unrecognizable, not acknowledged.
    if (!value.trim()) return null;
    text = value + text;
    if (/^\s*›(?:\s|$)/.test(value)) {
      return { text, images: [...text.matchAll(/\[Image #\d+\]/g)].length };
    }
  }
  return null;
}

export function attachmentReflected(
  before: ComposerSnapshot,
  after: ComposerSnapshot | null,
  path: string,
  image: boolean,
) {
  if (!after) return false;
  if (image) return after.images > before.images;
  const name = path.split(/[\\/]/).at(-1)!;
  // The generated ASCII suffix survives visual wrapping next to spaces in the
  // original filename; it still uniquely identifies this uploaded attachment.
  const needle = name.match(/-\d{10,}-[a-f\d]{8}(?:\.[^.]+)?$/i)?.[0] || name;
  return !before.text.includes(needle) && after.text.includes(needle);
}

/** Bounded polling owns one timer and removes its abort listener on every exit. */
export function waitForAttachment<T>(options: {
  signal: AbortSignal;
  ready: () => boolean;
  read: () => T | null;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T | null> {
  const { signal, ready, read, timeoutMs = 5000, intervalMs = 40 } = options;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    const finish = (value: T | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => finish(null);
    const tick = () => {
      try {
        if (signal.aborted || !ready()) return finish(null);
        const value = read();
        if (value !== null) return finish(value);
        if (Date.now() >= deadline) return finish(null);
        timer = setTimeout(tick, intervalMs);
      } catch {
        finish(null);
      }
    };
    signal.addEventListener("abort", aborted, { once: true });
    tick();
  });
}
