import { createHash } from "node:crypto";
import { expandTimeline, type HistoryDetail } from "../shared/history.js";
import type { MessageItem } from "../shared/types.js";

export interface ActivityView {
  id: string;
  runtimeId: string;
  nativeId: string;
  provider: "claude" | "codex";
  cwd: string;
  status: string;
  items: MessageItem[];
  contentRevision?: number;
}
const key = (item: MessageItem) => item.kind + ":" + item.id;
const prompt = (item: MessageItem) =>
  item.kind === "user" && !item.origin && item.status !== "queued";
function latestPromptIndex(items: MessageItem[]) {
  for (let i = items.length - 1; i >= 0; i--) if (prompt(items[i])) return i;
  return -1;
}
const work = (item: MessageItem) =>
  ["command", "change", "tool", "plan"].includes(item.kind);
const running = (v: ActivityView) =>
  v.status === "running" || v.status === "waiting";
interface Projected {
  anchor: string;
  item: MessageItem;
}
interface Entry {
  identity: string;
  promptKey: string;
  observedPrompt?: string;
  rows: Projected[];
  stamp: string;
  at: number;
  running: boolean;
  loading?: Promise<void>;
}

/** Add only missing public activity belonging to the last prompt of this exact conversation. */
function projection(view: ActivityView, history: HistoryDetail, entry: Entry): Projected[] {
  const items = view.items,
    start = latestPromptIndex(items),
    user = items[start];
  if (!user) return [];
  const timeline = expandTimeline(history),
    previous = latestPromptIndex(timeline),
    native = timeline[previous];
  if (!native) return [];
  const tail = timeline.slice(previous + 1);
  const nativeMatch =
    user.id === native.id || (!!user.turnId && user.turnId === native.turnId) || entry.observedPrompt === native.id;
  if (!nativeMatch) {
    // Early Claude SDK clients assigned a separate request UUID. A unique exact
    // typed prompt in both tails can be anchored only while its native turn is open.
    if (
      view.provider !== "claude" ||
      !running(view) ||
      user.imageCount ||
      native.imageCount ||
      !user.text ||
      user.text !== native.text ||
      items.filter((i) => prompt(i) && i.text === user.text).length !== 1 ||
      timeline.filter((i) => prompt(i) && i.text === user.text).length !== 1 ||
      tail.some(
        (i) =>
          i.phase === "final_answer" ||
          ["completed", "failed", "interrupted"].includes(i.turnStatus || ""),
      )
    )
      return [];
  }
  entry.observedPrompt = native.id;
  const existing = new Map(items.slice(start).map((i) => [key(i), i]));
  // A serving worker producing native tool records already owns this turn's ordering.
  if (items.slice(start + 1).some(work)) return [];
  const reported = items.slice(start + 1).filter((i) => i.kind === "assistant");
  const found: Projected[] = [];
  let anchor = key(user);
  for (const item of tail) {
    if (item.turnId && native.turnId && item.turnId !== native.turnId) continue;
    const id = key(item);
    if (existing.has(id)) {
      anchor = id;
      continue;
    }
    if (item.kind === "assistant") {
      const matches = reported.filter((i) => i.text === item.text);
      if (matches.length) {
        if (matches.length === 1) anchor = key(matches[0]);
        continue;
      }
      if (item.phase !== "commentary" || !item.text.trim()) continue;
    } else if (!work(item)) continue;
    if (item.id.length > 256) continue;
    const text = item.text.slice(0, 1200),
      detail = item.detail?.slice(-2400);
    found.push({
      anchor,
      item: {
        id: item.id,
        kind: item.kind,
        text,
        detail,
        phase: item.phase,
        status: item.status,
        turnStatus: item.turnStatus,
        turnId: user.turnId || native.turnId,
        toolUseId: item.toolUseId,
        format: item.format,
        activityTruncated:
          item.activityTruncated ||
          text !== item.text ||
          detail !== item.detail,
      },
    });
    if (found.length > 64) found.shift();
  }
  let bytes = 0;
  const latest: Projected[] = [];
  const seen = new Set<string>();
  for (let i = found.length - 1; i >= 0 && latest.length < 32; i--) {
    const row = found[i],
      id = key(row.item);
    if (seen.has(id)) continue;
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 48000) break;
    seen.add(id);
    latest.push(row);
  }
  return latest.reverse();
}

export class WorkspaceActivity {
  private readonly cache = new Map<string, Entry>();
  constructor(private readonly now = Date.now) {}
  private refresh(entry: Entry) {
    return entry.running && this.now() - entry.at >= 5000;
  }
  conditional(scope: string, token?: string) {
    if (!token) return;
    const parts = /^([a-f0-9-]{36}:\d{1,16})(?:\.([a-f0-9]{24}))?$/i.exec(
      token,
    );
    if (!parts) return;
    const entry = this.cache.get(scope);
    if (!entry && parts[2]) return;
    if (
      entry &&
      (this.refresh(entry) ||
        (parts[2] !== entry.stamp && (parts[2] || entry.stamp)))
    )
      return;
    return parts[1];
  }
  clear(scope: string) {
    this.cache.delete(scope);
  }
  async enrich(
    scope: string,
    hostId: string,
    v: ActivityView,
    read: () => Promise<HistoryDetail>,
    recheck: () => Promise<ActivityView | undefined>,
    guard: () => void,
    requested?: string,
  ) {
    const latest = v.items[latestPromptIndex(v.items)],
      identity = JSON.stringify([v.runtimeId, v.provider, v.nativeId, v.cwd]);
    if (!latest) {
      this.clear(scope);
      return v;
    }
    let e = this.cache.get(scope);
    if (!e || e.identity !== identity || e.promptKey !== key(latest)) {
      if (!running(v)) {
        this.clear(scope);
        return v;
      }
      e = {
        identity,
        promptKey: key(latest),
        rows: [],
        stamp: "",
        at: -Infinity,
        running: true,
      };
      this.cache.set(scope, e);
      if (this.cache.size > 48)
        this.cache.delete(this.cache.keys().next().value!);
    }
    const row = e;
    if (v.items.slice(latestPromptIndex(v.items) + 1).some(work)) {
      this.clear(scope);
      return v;
    }
    const needRead = this.refresh(row) || (row.running && !running(v));
    row.running = running(v);
    if (needRead && !row.loading) {
      row.at = this.now();
      row.loading = (async () => {
        try {
          const saved = await read();
          if (
            saved.thread.id === v.nativeId &&
            saved.thread.hostId === hostId &&
            (!saved.thread.provider || saved.thread.provider === v.provider) &&
            saved.thread.cwd === v.cwd
          ) {
            row.rows = projection(v, saved, row);
            row.stamp = row.rows.length
              ? createHash("sha256")
                  .update(JSON.stringify(row.rows))
                  .digest("hex")
                  .slice(0, 24)
              : "";
          } else {
            row.rows = [];
            row.stamp = "";
          }
        } catch {
          /* An unavailable journal leaves the native view usable. */
        }
      })().finally(() => {
        row.loading = undefined;
        row.at = this.now();
      });
    }
    if (row.loading) {
      // Slow SSH history must not block the normal worker snapshot. A new
      // activity digest makes the next poll fetch a fresh, authorized snapshot.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const priorStamp = row.stamp;
      const ready = await Promise.race([
        row.loading.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 120);
        }),
      ]).finally(() => clearTimeout(timer));
      guard();
      if (!ready && priorStamp !== row.stamp) return v;
      // Telemetry ran outside the worker. Re-authorize the exact native handle before releasing it.
      const current = ready ? await recheck() : undefined;
      guard();
      if (current) {
        if (
          current.runtimeId !== v.runtimeId ||
          current.cwd !== v.cwd ||
          current.provider !== v.provider ||
          current.nativeId !== v.nativeId
        )
          throw Object.assign(Error("조회 중 대화 연결이 바뀌었습니다."), {
            status: 409,
          });
        v = current;
      }
    }
    guard();
    const start = latestPromptIndex(v.items);
    if (
      this.cache.get(scope) !== row ||
      !v.items[start] ||
      key(v.items[start]) !== row.promptKey ||
      v.items.slice(start + 1).some(work) ||
      !row.rows.length
    )
      return v;
    const stamp =
      v.contentRevision === undefined
        ? undefined
        : v.runtimeId + ":" + v.contentRevision + "." + row.stamp;
    if (stamp && requested === stamp) return { unchanged: true };
    const present = new Set(v.items.map(key));
    const assistantText = new Set(
      v.items
        .slice(start + 1)
        .filter((i) => i.kind === "assistant")
        .map((i) => i.text),
    );
    const after = new Map<string, MessageItem[]>();
    for (const { anchor, item } of row.rows) {
      if (
        present.has(key(item)) ||
        (item.kind === "assistant" && assistantText.has(item.text))
      )
        continue;
      const group = after.get(anchor) || [];
      group.push(item);
      after.set(anchor, group);
    }
    return {
      ...v,
      pollRevision: stamp,
      items: v.items.flatMap((i) => [i, ...(after.get(key(i)) || [])]),
    };
  }
}
