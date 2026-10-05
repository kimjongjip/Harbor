import type { TerminalColors } from "../shared/types.js";

export const DEFAULT_TERMINAL_COLORS: TerminalColors = {
  foreground: "#20242c",
  background: "#ffffff",
};

/** Answer only fresh default-color queries, before a viewer can miss startup. */
export class TerminalColorResponder {
  private colors: TerminalColors;
  private mode: "text" | "escape" | "osc" | "osc-pass" | "string" = "text";
  private pending = "";
  private escaped = false;

  constructor(colors: TerminalColors = DEFAULT_TERMINAL_COLORS) {
    this.colors = this.validated(colors);
  }
  private validated(colors: TerminalColors) {
    if (
      !/^#[\da-f]{6}$/i.test(colors.foreground) ||
      !/^#[\da-f]{6}$/i.test(colors.background)
    )
      throw new Error("터미널 색상 형식이 올바르지 않습니다.");
    return {
      foreground: colors.foreground.toLowerCase(),
      background: colors.background.toLowerCase(),
    };
  }
  update(colors: TerminalColors) {
    this.colors = this.validated(colors);
  }
  private reply(code: 10 | 11) {
    const hex = this.colors[code === 10 ? "foreground" : "background"].slice(1);
    const rgb = [0, 2, 4]
      .map((offset) => hex.slice(offset, offset + 2).repeat(2))
      .join("/");
    return `\x1b]${code};rgb:${rgb}\x1b\\`;
  }
  consume(data: string): { output: string; replies: string[] } {
    const output: string[] = [],
      replies: string[] = [];
    for (const char of data) {
      if (this.mode === "text") {
        if (char === "\x1b") {
          this.mode = "escape";
          this.pending = char;
        } else if (char === "\x9d") {
          this.mode = "osc";
          this.pending = char;
        } else if ("\x90\x98\x9e\x9f".includes(char)) {
          output.push(char);
          this.mode = "string";
          this.escaped = false;
        } else output.push(char);
      } else if (this.mode === "escape") {
        this.pending += char;
        if (char === "]") {
          this.mode = "osc";
          this.escaped = false;
        } else {
          output.push(this.pending);
          this.pending = "";
          this.mode = "P_X^".includes(char) ? "string" : "text";
          this.escaped = false;
        }
      } else if (this.mode === "osc") {
        this.pending += char;
        const cancelled = char === "\x18" || char === "\x1a";
        const complete =
          cancelled ||
          char === "\x07" ||
          char === "\x9c" ||
          (this.escaped && char === "\\");
        if (complete) {
          const body = this.pending
            .replace(/^(?:\x1b\]|\x9d)/, "")
            .replace(/(?:\x1b\\|[\x07\x9c])$/, "");
          if (!cancelled && /^10;\?(?:;\?)?$/.test(body)) {
            replies.push(this.reply(10));
            if (body === "10;?;?") replies.push(this.reply(11));
          } else if (!cancelled && body === "11;?")
            replies.push(this.reply(11));
          else output.push(this.pending);
          this.pending = "";
          this.mode = "text";
          this.escaped = false;
        } else if (this.pending.length > 64) {
          // Inline images and arbitrary OSC payloads stream without buffering.
          output.push(this.pending);
          this.pending = "";
          this.mode = "osc-pass";
          this.escaped = char === "\x1b";
        } else this.escaped = char === "\x1b";
      } else {
        // Preserve control strings verbatim. OSC-like bytes in SIXEL/DCS/APC
        // payloads must never be treated as a query and injected into stdin.
        output.push(char);
        if (
          char === "\x18" ||
          char === "\x1a" ||
          char === "\x9c" ||
          (this.mode === "osc-pass" && char === "\x07") ||
          (this.escaped && char === "\\")
        ) {
          this.mode = "text";
          this.escaped = false;
        } else this.escaped = char === "\x1b";
      }
    }
    return { output: output.join(""), replies };
  }
  flush() {
    const pending = this.pending;
    this.pending = "";
    this.mode = "text";
    this.escaped = false;
    return pending;
  }
}
