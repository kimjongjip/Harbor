import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import type {
  RichTerminalBlock,
  RichTerminalReply,
} from "../shared/rich-terminal.js";

export const richRequest = z.object({
  requestId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  text: z.string().min(1).max(128000),
  columns: z.number().int().min(40).max(500),
  viewportRows: z.number().int().min(3).max(300).default(30),
  cwd: z.string().max(4096).optional(),
  component: z.literal("AssistantMessage").optional(),
  renderer: z.literal("rows-v2").optional(),
});
export const richLayout = z.object({
  sessionId: z.string().min(1).max(256),
  rows: z.number().int().min(1).max(400).optional(),
  columns: z.number().int().min(40).max(500),
  available: z.boolean(),
});
interface Slot {
  enabled: boolean;
  sessionId: string;
  blocks: Map<string, RichTerminalBlock>;
  waits: Map<string, Set<(reply: RichTerminalReply) => void>>;
}
/** Canonical text never comes from ANSI scraping or an unauthenticated OSC. */
export class RichTerminals extends EventEmitter {
  private slots = new Map<string, Slot>();
  constructor(
    private timeoutMs = 12000,
    private file?: string,
  ) {
    super();
    if (file)
      try {
        if (statSync(file).size > 8 * 1024 * 1024) return;
        const saved = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(saved)) return;
        for (const item of saved.slice(0, 16)) {
          if (typeof item.id !== "string" || !Array.isArray(item.blocks))
            continue;
          const sessionId = z.string().min(1).max(256).parse(item.sessionId);
          const slot = this.slot(item.id, sessionId);
          for (const candidate of item.blocks.slice(-64)) {
            const input = richRequest.parse(candidate);
            if (
              input.sessionId !== sessionId ||
              !/^[a-f0-9]{20}$/.test(candidate.id) ||
              candidate.marker !== `~HBR:${candidate.id}~`
            )
              continue;
            const rows = z
              .number()
              .int()
              .min(1)
              .max(400)
              .optional()
              .parse(candidate.rows);
            const block: RichTerminalBlock = {
              ...input,
              id: candidate.id,
              marker: candidate.marker,
              rows,
              state: "pending",
              createdAt: Number(candidate.createdAt) || Date.now(),
              ...(candidate.placement === "card"
                ? { placement: "card" as const }
                : {}),
            };
            slot.blocks.set(
              JSON.stringify([
                input.requestId,
                input.columns,
                input.viewportRows,
                input.renderer || "card",
              ]),
              block,
            );
          }
        }
      } catch {
        /* Broken display cache must not prevent opening the shell. */
      }
  }
  private save() {
    if (!this.file) return;
    const data = JSON.stringify(
      [...this.slots].map(([id, slot]) => ({
        id,
        sessionId: slot.sessionId,
        blocks: [...slot.blocks.values()],
      })),
    );
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) return;
    try {
      writeFileSync(`${this.file}.tmp`, data, { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      /* Rendering still has its native-text fallback. */
    }
  }
  private slot(id: string, sessionId: string) {
    let slot = this.slots.get(id);
    if (!slot || slot.sessionId !== sessionId) {
      this.clear(id);
      slot = { enabled: true, sessionId, blocks: new Map(), waits: new Map() };
      this.slots.set(id, slot);
    }
    return slot;
  }
  list(id: string) {
    return [...(this.slots.get(id)?.blocks.values() || [])];
  }
  enabled(id: string) {
    return this.slots.get(id)?.enabled !== false;
  }
  /** Final primary-thread Codex messages never reserve or rewrite native TUI rows. */
  publishCard(id: string, value: unknown) {
    const input = richRequest.parse(value);
    if (Buffer.byteLength(input.text) > 256000) return;
    const slot = this.slot(id, input.sessionId);
    if (!slot.enabled) return;
    const key = JSON.stringify([
      input.requestId,
      input.columns,
      input.viewportRows,
      input.renderer || "card",
    ]);
    const previous = slot.blocks.get(key);
    if (previous?.text === input.text) {
      if (previous.placement !== "card") {
        previous.placement = "card";
        previous.state = "pending";
        previous.rows = undefined;
        this.save();
        this.emit("block", id, { ...previous });
      }
      return;
    }
    if (previous) this.finish(slot, previous.id, { enabled: false });
    while (
      slot.blocks.size >= 64 ||
      [...slot.blocks.values()].reduce(
        (sum, b) => sum + b.text.length,
        input.text.length,
      ) > 2_000_000
    ) {
      const first = slot.blocks.keys().next().value as string | undefined;
      if (!first) break;
      this.finish(slot, slot.blocks.get(first)!.id, { enabled: false });
      slot.blocks.delete(first);
    }
    const uuid = randomUUID().replaceAll("-", "").slice(0, 20);
    const block: RichTerminalBlock = {
      ...input,
      id: uuid,
      createdAt: Date.now(),
      marker: `~HBR:${uuid}~`,
      state: "pending",
      placement: "card",
    };
    slot.blocks.set(key, block);
    this.save();
    this.emit("block", id, { ...block });
  }
  setEnabled(id: string, sessionId: string, enabled: boolean) {
    const slot = this.slot(id, sessionId);
    slot.enabled = enabled;
    if (!enabled)
      for (const waits of slot.waits.values())
        for (const done of [...waits]) done({ enabled: false });
  }
  request(id: string, value: unknown): Promise<RichTerminalReply> {
    const input = richRequest.parse(value);
    // Old first-row-only reservations can become an entire blank viewport.
    // Existing native CLIs fall back to their own text without a restart.
    if (input.renderer !== "rows-v2") {
      this.publishCard(id, input);
      return Promise.resolve({ enabled: false });
    }
    const slot = this.slot(id, input.sessionId);
    if (!slot.enabled || Buffer.byteLength(input.text) > 256000)
      return Promise.resolve({ enabled: false });
    const key = JSON.stringify([
      input.requestId,
      input.columns,
      input.viewportRows,
      input.renderer || "card",
    ]);
    let block = slot.blocks.get(key);
    if (block && block.text !== input.text) {
      // The same semantic ID with changed contents is a new block revision.
      this.finish(slot, block.id, { enabled: false });
      slot.blocks.delete(key);
      block = undefined;
    }
    if (!block) {
      while (
        slot.blocks.size >= 64 ||
        [...slot.blocks.values()].reduce(
          (sum, b) => sum + b.text.length,
          input.text.length,
        ) > 2_000_000
      ) {
        const first = slot.blocks.keys().next().value as string | undefined;
        if (!first) break;
        this.finish(slot, slot.blocks.get(first)!.id, { enabled: false });
        slot.blocks.delete(first);
      }
      const uuid = randomUUID().replaceAll("-", "").slice(0, 20);
      block = {
        ...input,
        id: uuid,
        createdAt: Date.now(),
        marker: `~HBR:${uuid}~`,
        state: "pending",
      };
      slot.blocks.set(key, block);
      this.save();
    }
    if (block.state === "ready") return Promise.resolve(this.reply(block));
    block.state = "pending";
    const pending = block;
    const promise = new Promise<RichTerminalReply>((resolve) => {
      const waits = slot.waits.get(pending.id) || new Set();
      const done = (reply: RichTerminalReply) => {
        clearTimeout(timer);
        waits.delete(done);
        if (!waits.size) slot.waits.delete(pending.id);
        resolve(reply);
      };
      const timer = setTimeout(() => done({ enabled: false }), this.timeoutMs);
      waits.add(done);
      slot.waits.set(pending.id, waits);
    });
    this.emit("block", id, { ...block });
    return promise;
  }
  acknowledge(id: string, blockId: string, value: unknown) {
    const input = richLayout.parse(value);
    const slot = this.slots.get(id);
    const block =
      slot && [...slot.blocks.values()].find((b) => b.id === blockId);
    if (
      !slot ||
      !block ||
      block.sessionId !== input.sessionId ||
      block.columns !== input.columns
    )
      throw new Error("현재 답변의 조판 요청을 찾을 수 없습니다.");
    if (input.available && !input.rows)
      throw new Error("조판 높이가 없습니다.");
    // A native Box already occupies these rows. Later font/image changes must
    // scroll inside that allocation, never grow over the live CLI input.
    block.rows =
      block.placement === "card" ? input.rows : (block.rows ?? input.rows);
    block.state = input.available ? "ready" : "unavailable";
    this.save();
    this.finish(
      slot,
      block.id,
      slot.enabled && input.available ? this.reply(block) : { enabled: false },
    );
    this.emit("block", id, { ...block });
  }
  private reply(block: RichTerminalBlock): RichTerminalReply {
    return {
      enabled: true,
      id: block.id,
      marker: block.marker,
      rows: block.rows!,
      columns: block.columns,
    };
  }
  private finish(slot: Slot, blockId: string, reply: RichTerminalReply) {
    for (const done of [...(slot.waits.get(blockId) || [])]) done(reply);
  }
  clear(id: string) {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot)
      for (const waits of slot.waits.values())
        for (const done of [...waits]) done({ enabled: false });
    this.slots.delete(id);
    this.save();
  }
  dispose() {
    this.save();
    for (const slot of this.slots.values())
      for (const waits of slot.waits.values())
        for (const done of [...waits]) done({ enabled: false });
    this.slots.clear();
  }
}
