import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { TerminalReplay } from "./terminal-replay.js";
import type { TerminalReplayMetadata } from "../shared/types.js";
import { serializeTerminalLinks, terminalLinkSuffix } from "./terminal-screen-links.js";
import {
  alternateBufferPrefix,
  terminalStateSuffix,
} from "./terminal-screen-state.js";

const { Terminal } = headless;
const { SerializeAddon } = serialize;

/** Current terminal state, independent of the bounded raw-output tail. */
export class TerminalScreen {
  readonly history: TerminalReplay;
  private terminal = new Terminal({
    cols: 100,
    rows: 30,
    scrollback: 2000,
    allowProposedApi: true,
  });
  private serializer = new SerializeAddon();
  private operations: ({ data: string } | { run: () => void })[] = [];
  private draining = false;
  private rawImages = false;
  private prefix = "";
  private disposed = false;
  constructor(limit?: number) {
    this.history = new TerminalReplay(limit);
    this.terminal.loadAddon(this.serializer);
    // This emulator observes output only. Its device-query replies must never
    // reach the process; the visible terminal is the sole interactive client.
  }
  private schedule<T>(operation: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.operations.push({
        run: () => {
          try {
            resolve(operation());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.drain();
    });
  }
  private drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.operations.length) {
      const operation = this.operations[0];
      if ("run" in operation) {
        this.operations.shift();
        operation.run();
        continue;
      }
      let count = 0;
      const chunks: string[] = [];
      for (const item of this.operations) {
        if (!("data" in item)) break;
        chunks.push(item.data);
        count++;
      }
      this.operations.splice(0, count);
      this.terminal.write(chunks.join(""), () => {
        this.draining = false;
        this.drain();
      });
      return;
    }
    this.draining = false;
  }
  append(data: string) {
    if (this.disposed) return;
    this.history.append(data);
    const probe = this.prefix + data;
    // Headless xterm does not implement the browser image addon. Keep that
    // protocol's original atomic replay instead of silently discarding images.
    this.rawImages ||= /\x1b(?:\]1337;File=|P|_G)/.test(probe);
    this.prefix = probe.slice(-16);
    this.operations.push({ data });
    this.drain();
  }
  resize(cols: number, rows: number) {
    if (this.disposed || !this.history.resize(cols, rows)) return false;
    void this.schedule(() => this.terminal.resize(cols, rows));
    return true;
  }
  snapshot(): Promise<{ data: string; replay: TerminalReplayMetadata }> {
    const raw = this.history.snapshot();
    const pending = this.history.pendingControl();
    const rawImages = this.rawImages;
    return this.schedule(() => {
      const core = (this.terminal as any)._core;
      const normal = core._bufferService.buffers.normal;
      // Designated legacy character sets have no public serialization API.
      // Preserve their original control stream rather than claiming a snapshot.
      if (
        rawImages ||
        core._charsetService.charset ||
        core._charsetService._charsets.some(Boolean) ||
        core._bufferService.buffer.savedCharset ||
        (this.terminal.buffer.active.type === "alternate" &&
          (normal.scrollTop !== 0 ||
            normal.scrollBottom !== this.terminal.rows - 1))
      )
        return raw;
      return {
        // The addon serializes normal and alternate buffers separately, but
        // leaves the normal cursor's SGR active at the alternate transition.
        // Start that independent cell stream from its assumed default style.
        data:
          serializeTerminalLinks(this.terminal, () => this.serializer.serialize())
            .replace(
              "\x1b[?1049h\x1b[H",
              alternateBufferPrefix(this.terminal),
            ) +
          terminalStateSuffix(this.terminal) +
          terminalLinkSuffix(this.terminal) +
          pending,
        replay: {
          cols: this.terminal.cols,
          rows: this.terminal.rows,
          resizes: [],
          snapshot: true,
        },
      };
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    void this.schedule(() => this.terminal.dispose());
  }
}
