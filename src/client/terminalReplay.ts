import type { Terminal } from "@xterm/xterm";
import type { TerminalReplayMetadata } from "../shared/types";

export const writeTerminal = (
  term: Terminal,
  data: string,
  signal?: AbortSignal,
) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Terminal view changed"));
      return;
    }
    const timer = setTimeout(
      () => finish(new Error("터미널 화면 그리기 시간이 초과됐습니다.")),
      15000,
    );
    const aborted = () => finish(new Error("Terminal view changed"));
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      term.write(data, () => finish());
    } catch (error) {
      finish(error as Error);
    }
  });

/** Resize only after preceding output has actually reached xterm's parser. */
export async function restoreTerminalReplay(
  term: Terminal,
  data: string,
  replay: TerminalReplayMetadata | undefined,
  current: () => boolean,
  beforeReset?: () => void,
  signal?: AbortSignal,
) {
  if (!current()) return false;
  // Drain a previous connection's writes before clearing its screen.
  await writeTerminal(term, "", signal);
  if (!current()) return false;
  beforeReset?.();
  term.reset();
  term.resize(replay?.cols ?? 100, replay?.rows ?? 30);
  let offset = 0;
  for (const size of replay?.resizes || []) {
    if (size.offset > offset)
      await writeTerminal(term, data.slice(offset, size.offset), signal);
    if (!current()) return false;
    term.resize(size.cols, size.rows);
    offset = size.offset;
  }
  if (offset < data.length)
    await writeTerminal(term, data.slice(offset), signal);
  return current();
}
