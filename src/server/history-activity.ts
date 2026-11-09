import { createHash } from "node:crypto";
import type { HostConfig, MessageItem } from "../shared/types.js";
import type { HistoryActivityPage } from "../shared/history.js";

type Provider = "codex" | "claude";
interface Entry { binding: string; text: string; bytes: number; expires: number }
export interface ActivityBudget { remaining: number; truncated: boolean }
export const activityBudget = (): ActivityBudget => ({ remaining: 96000, truncated: false });
const bindingFor = (host: HostConfig, provider: Provider, sessionId: string) =>
  JSON.stringify([host.id, host.kind, host.address, host.username, host.port, host.identityFile, host.codexPath, provider, sessionId]);

/** Exact saved public output, never an AI-generated summary. Memory and lifetime are bounded. */
export class HistoryActivities {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly ttlMs = 15 * 60_000,
    private readonly clock = Date.now,
  ) {}
  private remove(ref: string) {
    const entry = this.entries.get(ref);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(ref); }
  }
  private prune() {
    const now = this.clock();
    for (const [ref, entry] of this.entries) if (entry.expires <= now) this.remove(ref);
  }
  preview(host: HostConfig, provider: Provider, sessionId: string, item: MessageItem, budget: ActivityBudget): MessageItem {
    const textLimit = Math.min(4000, Math.max(160, budget.remaining));
    const text = item.text.slice(0, textLimit);
    const detailLimit = Math.min(4000, Math.max(0, budget.remaining - text.length));
    const detail = item.detail?.slice(0, detailLimit);
    budget.remaining = Math.max(0, budget.remaining - text.length - (detail?.length || 0));
    if (text === item.text && detail === item.detail) return item;
    budget.truncated = true;
    const original = item.text + (item.detail ? `\n${item.detail}` : "");
    const binding = bindingFor(host, provider, sessionId);
    const ref = createHash("sha256").update(binding).update("\0").update(item.id).update("\0").update(original).digest("hex");
    this.prune();
    const existing = this.entries.get(ref);
    if (existing) {
      this.entries.delete(ref);
      existing.expires = this.clock() + this.ttlMs;
      this.entries.set(ref, existing);
    } else {
      // JS strings are UTF-16: count retained string memory conservatively.
      const bytes = original.length * 2;
      if (bytes <= this.maxBytes) {
        while (this.bytes + bytes > this.maxBytes || this.entries.size >= 4096)
          this.remove(this.entries.keys().next().value!);
        this.entries.set(ref, { binding, text: original, bytes, expires: this.clock() + this.ttlMs });
        this.bytes += bytes;
      }
    }
    return { ...item, text, detail, activityTruncated: true,
      ...(this.entries.has(ref) ? { activityRef: ref } : {}) };
  }
  read(host: HostConfig, provider: Provider, sessionId: string, ref: string, offset = 0): HistoryActivityPage {
    if (!/^[a-f0-9]{64}$/.test(ref) || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error("잘못된 작업 원문 위치입니다.");
    this.prune();
    const entry = this.entries.get(ref);
    if (!entry || entry.binding !== bindingFor(host, provider, sessionId))
      throw new Error("작업 원문을 다시 불러와야 합니다. 기록을 새로고침한 뒤 펼쳐 주세요.");
    if (offset > entry.text.length) throw new Error("잘못된 작업 원문 위치입니다.");
    let end = Math.min(entry.text.length, offset + 64 * 1024);
    if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end--;
    entry.expires = this.clock() + this.ttlMs;
    this.entries.delete(ref); this.entries.set(ref, entry);
    return { text: entry.text.slice(offset, end), offset, total: entry.text.length,
      nextOffset: end < entry.text.length ? end : null };
  }
}

export const historyActivities = new HistoryActivities();
