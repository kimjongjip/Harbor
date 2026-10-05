import type { Terminal } from "@xterm/xterm";
import type { TerminalReplayMetadata } from "../shared/types";

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

/** Resize only after preceding output has actually reached xterm's parser. */
export async function restoreTerminalReplay(
  term: Terminal,
  data: string,
  replay: TerminalReplayMetadata | undefined,
  current: () => boolean,
  beforeReset?: () => void,
) {
  if (!current()) return false;
  // Drain a previous connection's writes before clearing its screen.
  await write(term, "");
  if (!current()) return false;
  beforeReset?.();
  term.reset();
  term.resize(replay?.cols ?? 100, replay?.rows ?? 30);
  let offset = 0;
  for (const size of replay?.resizes || []) {
    if (size.offset > offset)
      await write(term, data.slice(offset, size.offset));
    if (!current()) return false;
    term.resize(size.cols, size.rows);
    offset = size.offset;
  }
  if (offset < data.length) await write(term, data.slice(offset));
  return current();
}
