import type { TerminalReplayMetadata } from "../../shared/types";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
type Entry = {
  data?: string;
  replay?: TerminalReplayMetadata;
  blocks: RichTerminalBlock[];
  blockBytes: number;
};
/** Bounded, memory-only previews; never used as input readiness or persisted to disk. */
export class MobileScreenCache {
  private entries = new Map<string, Entry>();
  constructor(
    private maxEntries = 3,
    private maxBytes = 6 * 1024 * 1024,
  ) {}
  clear() {
    this.entries.clear();
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      ...entry,
      replay: entry.replay ? structuredClone(entry.replay) : undefined,
    };
  }
  private save(key: string, entry: Entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    const size = () =>
      [...this.entries.values()].reduce(
        (n, e) => n + 2 * (e.data?.length || 0) + e.blockBytes,
        0,
      );
    while (this.entries.size > this.maxEntries || size() > this.maxBytes)
      this.entries.delete(this.entries.keys().next().value!);
  }
  snapshot(key: string, data: string, replay?: TerminalReplayMetadata) {
    this.save(key, {
      data,
      replay: replay ? structuredClone(replay) : undefined,
      blocks: this.entries.get(key)?.blocks || [],
      blockBytes: this.entries.get(key)?.blockBytes || 0,
    });
  }
  append(key: string, data: string) {
    const entry = this.entries.get(key);
    if (entry?.data !== undefined)
      this.save(key, { ...entry, data: entry.data + data });
  }
  resize(key: string, cols: number, rows: number) {
    const entry = this.entries.get(key);
    if (entry?.data === undefined) return;
    const replay = entry.replay || { cols: 100, rows: 30, resizes: [] };
    if (replay.resizes.length >= 1000) {
      this.entries.delete(key);
      return;
    }
    this.save(key, {
      ...entry,
      replay: {
        ...replay,
        resizes: [...replay.resizes, { offset: entry.data.length, cols, rows }],
      },
    });
  }
  answers(key: string, blocks: RichTerminalBlock[]) {
    this.save(key, {
      ...this.entries.get(key),
      blocks,
      blockBytes: 2 * JSON.stringify(blocks).length,
    });
  }
}
