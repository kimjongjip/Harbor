import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { TerminalNotice } from "../shared/notices.js";

/** Parse attention OSCs as they arrive, including split sequences; never replay alerts. */
export class TerminalNotices extends EventEmitter {
  private parsers = new Map<
    string,
    {
      mode: "text" | "escape" | "osc" | "oscEscape";
      text: string;
      overflow: boolean;
    }
  >();
  private notices: TerminalNotice[] = [];
  list() {
    return this.notices.map((n) => ({ ...n }));
  }
  append(id: string, title: string, data: string) {
    let parser = this.parsers.get(id);
    if (!parser) {
      parser = { mode: "text", text: "", overflow: false };
      this.parsers.set(id, parser);
    }
    const finish = () => {
      if (!parser!.overflow) {
        const text = parser!.text;
        if (text.startsWith("9;") && !text.startsWith("9;4;"))
          this.push(id, title, text.slice(2));
        else if (text.startsWith("777;notify;"))
          this.push(id, title, text.slice(11).replaceAll(";", " · "));
      }
      parser!.text = "";
      parser!.overflow = false;
      parser!.mode = "text";
    };
    for (const c of data) {
      if (parser.mode === "text") {
        if (c === "\x1b") parser.mode = "escape";
        else if (c === "\x07")
          this.push(
            id,
            title,
            "터미널에서 알림을 보냈습니다. 입력이나 작업 결과를 확인하세요.",
          );
      } else if (parser.mode === "escape") {
        parser.mode = c === "]" ? "osc" : c === "\x1b" ? "escape" : "text";
      } else if (parser.mode === "oscEscape") {
        if (c === "\\") finish();
        else {
          parser.mode = "osc";
          parser.overflow = true;
        }
      } else if (c === "\x07") finish();
      else if (c === "\x1b") parser.mode = "oscEscape";
      else if (!parser.overflow) {
        parser.text += c;
        if (parser.text.length > 2000) {
          parser.overflow = true;
          parser.text = "";
        }
      }
    }
  }
  private push(terminalId: string, title: string, value: string) {
    const body = value
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim()
      .slice(0, 1000);
    if (!body) return;
    const at = Date.now();
    if (
      this.notices.some(
        (n) =>
          n.terminalId === terminalId && n.body === body && at - n.at < 5000,
      )
    )
      return;
    this.notices.unshift({
      id: randomUUID(),
      terminalId,
      title,
      body,
      at,
      read: false,
    });
    this.notices = this.notices.slice(0, 100);
    this.emit("change");
  }
  read(terminalId?: string) {
    let changed = false;
    for (const notice of this.notices)
      if (!notice.read && (!terminalId || notice.terminalId === terminalId)) {
        notice.read = true;
        changed = true;
      }
    if (changed) this.emit("change");
  }
  close(id: string) {
    this.parsers.delete(id);
  }
}
