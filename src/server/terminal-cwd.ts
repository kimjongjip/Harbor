/** Observe explicit shell metadata only; never infer a directory from printed commands. */
export class TerminalCwdObserver {
  private state: "text" | "escape" | "osc" | "osc-escape" | "opaque" | "opaque-escape" = "text";
  private payload = "";
  private overflow = false;
  consume(data: string): string[] {
    const result: string[] = [];
    const finish = () => {
      const payload = this.overflow ? "" : this.payload;
      let path = "";
      if (payload.startsWith("1337;CurrentDir=")) path = payload.slice(16);
      else if (payload.startsWith("7;file://")) {
        try {
          const url = new URL(payload.slice(2));
          path = decodeURIComponent(url.pathname);
          if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
        } catch { /* Ignore malformed metadata. */ }
      }
      if (path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path) && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) result.push(path);
      this.payload = "";
      this.overflow = false;
      this.state = "text";
    };
    for (const char of data) {
      if (char === "\x18" || char === "\x1a") { this.payload = ""; this.overflow = false; this.state = "text"; continue; }
      if (this.state === "text") { if (char === "\x1b") this.state = "escape"; }
      else if (this.state === "escape") {
        if (char === "]") { this.state = "osc"; this.payload = ""; this.overflow = false; }
        else if ("P_X^".includes(char)) this.state = "opaque";
        else this.state = char === "\x1b" ? "escape" : "text";
      } else if (this.state === "opaque") { if (char === "\x1b") this.state = "opaque-escape"; }
      else if (this.state === "opaque-escape") this.state = char === "\\" ? "text" : char === "\x1b" ? "opaque-escape" : "opaque";
      else if (this.state === "osc-escape") {
        if (char === "\\") finish();
        else { this.payload = ""; this.overflow = false; this.state = "text"; }
      } else if (char === "\x07") finish();
      else if (char === "\x1b") this.state = "osc-escape";
      else if (this.payload.length < 8192) this.payload += char;
      else this.overflow = true;
    }
    return result;
  }
}
