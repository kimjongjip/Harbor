import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { TerminalNotice } from "../shared/notices.js";

/** Parse attention OSCs as they arrive, including split sequences; never replay alerts. */
export type RebootOutcome = "opening" | "ready" | "failed";
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
  private recovery = new Map<string, Map<string, RebootOutcome>>();
  reboot(
    hostId: string,
    hostName: string,
    boot: string,
    terminalId: string,
    outcome: RebootOutcome,
  ) {
    const id = "reboot-" + hostId + "-" + boot;
    for (const group of this.recovery.keys())
      if (!this.notices.some((n) => n.id === group))
        this.recovery.delete(group);
    const tabs = this.recovery.get(id) || new Map<string, RebootOutcome>();
    if (tabs.get(terminalId) === outcome) return;
    tabs.set(terminalId, outcome);
    this.recovery.set(id, tabs);
    const outcomes = [...tabs.values()];
    const restored = outcomes.filter((v) => v === "ready").length;
    const failed = outcomes.filter((v) => v === "failed").length;
    const opening = tabs.size - restored - failed;
    const body = [
      restored && `대화 ${restored}개를 복구했습니다.`,
      opening && `${opening}개 탭에서 원래 대화 재개를 요청했습니다.`,
      failed && `${failed}개 탭은 대화 기록을 확인해 주세요.`,
    ]
      .filter(Boolean)
      .join(" ");
    const notice = this.notices.find((n) => n.id === id);
    if (notice) notice.body = body;
    else
      this.notices = [
        {
          id,
          title: hostName + " 서버 재부팅",
          body,
          terminalId,
          at: Date.now(),
          read: false,
        },
        ...this.notices,
      ].slice(0, 100);
    this.emit("change");
  }
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
