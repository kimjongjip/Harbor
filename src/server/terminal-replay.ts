import type { TerminalReplayMetadata } from "../shared/types.js";

type ReplayPart =
  { value: string; atomic: boolean } | { cols: number; rows: number };

/** Bounded terminal history. Escape sequences, including inline images, are evicted whole. */
export class TerminalReplay {
  private parts: (ReplayPart | undefined)[] = [];
  private head = 0;
  private size = 0;
  private resizeCount = 0;
  private baseCols = 100;
  private baseRows = 30;
  private cols = 100;
  private rows = 30;
  private truncated = false;
  private deferredResize?: { cols: number; rows: number };
  private mode: "text" | "escape" | "csi" | "osc" | "string" = "text";
  private pending = "";
  private dropped = false;
  private escaped = false;
  private prefix = "";
  constructor(private limit = 4 * 1024 * 1024) {}
  resize(cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      (cols === this.cols && rows === this.rows)
    )
      return false;
    this.cols = cols;
    this.rows = rows;
    // Keep image/control strings atomic. A resize received during an unfinished
    // sequence is placed immediately after its terminator, never inside it.
    if (this.mode !== "text") this.deferredResize = { cols, rows };
    else this.pushResize({ cols, rows });
    return true;
  }
  private pushResize(dimensions: { cols: number; rows: number }) {
    const last = this.parts.at(-1);
    if (last && !("value" in last))
      this.parts[this.parts.length - 1] = dimensions;
    else {
      this.parts.push(dimensions);
      this.resizeCount++;
    }
    this.trim();
  }
  private capture(value: string) {
    if (this.dropped) return;
    if (this.pending.length + value.length > this.limit) {
      this.pending = "";
      this.dropped = true;
      this.truncated = true;
    } else this.pending += value;
  }
  private push(value: string, atomic = false) {
    if (!value) return;
    const last = this.parts.at(-1);
    if (
      !atomic &&
      last &&
      "value" in last &&
      !last.atomic &&
      last.value.length + value.length < 8192
    )
      last.value += value;
    else this.parts.push({ value, atomic });
    this.size += value.length;
    this.trim();
  }
  private trim() {
    while (
      this.head < this.parts.length &&
      (this.size > this.limit ||
        this.resizeCount > 256 ||
        !("value" in this.parts[this.head]!))
    ) {
      const first = this.parts[this.head]!;
      if (!("value" in first)) {
        this.baseCols = first.cols;
        this.baseRows = first.rows;
        this.removeFirst();
        this.resizeCount--;
        continue;
      }
      this.truncated = true;
      const excess = this.size - this.limit;
      if (
        this.resizeCount > 256 ||
        first.atomic ||
        first.value.length <= excess
      ) {
        this.size -= first.value.length;
        this.removeFirst();
      } else {
        const cut =
          excess + (/^[\uDC00-\uDFFF]/.test(first.value.slice(excess)) ? 1 : 0);
        first.value = first.value.slice(cut);
        this.size -= cut;
      }
    }
  }
  private removeFirst() {
    // Full TUI histories contain hundreds of thousands of small ANSI parts.
    // Array.shift() moves them all for every eviction and blocks PTY input.
    // Release old payloads immediately and compact only in amortized batches.
    this.parts[this.head++] = undefined;
    if (this.head === this.parts.length) {
      this.parts = [];
      this.head = 0;
    } else if (this.head >= 4096 && this.head * 2 >= this.parts.length) {
      this.parts = this.parts.slice(this.head);
      this.head = 0;
    }
  }
  append(data: string) {
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (this.mode === "text") {
        if (c === "\x1b") {
          this.push(data.slice(start, i));
          start = i;
          this.mode = "escape";
          this.prefix = "\x1b";
        }
        continue;
      }
      let complete = c === "\x18" || c === "\x1a";
      if (this.mode === "escape") {
        this.prefix += c;
        if (c === "[") this.mode = "csi";
        else if (c === "]") this.mode = "osc";
        else if ("P_^".includes(c)) this.mode = "string";
        else complete = true;
      } else if (this.mode === "csi") complete ||= c >= "@" && c <= "~";
      else {
        complete ||=
          (this.mode === "osc" && c === "\x07") ||
          c === "\x9c" ||
          (this.escaped && c === "\\");
        this.escaped = c === "\x1b";
      }
      if (complete) {
        this.capture(data.slice(start, i + 1));
        this.push(
          this.dropped
            ? "\r\n[이전의 큰 이미지 출력은 기록에서 생략됨]\r\n"
            : this.pending,
          true,
        );
        this.pending = "";
        this.dropped = false;
        this.escaped = false;
        this.prefix = "";
        this.mode = "text";
        if (this.deferredResize) {
          this.pushResize(this.deferredResize);
          this.deferredResize = undefined;
        }
        start = i + 1;
      }
    }
    if (this.mode === "text") this.push(data.slice(start));
    else this.capture(data.slice(start));
  }
  read() {
    // Keep a new viewer inside an oversized unfinished control string until its terminator arrives.
    const values: string[] = [];
    for (let index = this.head; index < this.parts.length; index++) {
      const part = this.parts[index]!;
      if ("value" in part) values.push(part.value);
    }
    return values.join("") + (this.dropped ? this.prefix : this.pending);
  }
  pendingControl() {
    return this.dropped ? this.prefix : this.pending;
  }
  snapshot(): { data: string; replay: TerminalReplayMetadata } {
    const data = this.read();
    let offset = 0;
    const resizes: TerminalReplayMetadata["resizes"] = [];
    for (let index = this.head; index < this.parts.length; index++) {
      const part = this.parts[index]!;
      if ("value" in part) offset += part.value.length;
      else resizes.push({ offset, cols: part.cols, rows: part.rows });
    }
    // The live PTY has already resized even if its last control string is still
    // arriving. A fresh viewer must reach that geometry before the next chunk.
    if (this.deferredResize)
      resizes.push({ offset: data.length, ...this.deferredResize });
    return {
      data,
      replay: {
        cols: this.baseCols,
        rows: this.baseRows,
        resizes,
        ...(this.truncated ? { truncated: true } : {}),
      },
    };
  }
}
