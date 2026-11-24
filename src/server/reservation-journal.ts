import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chatEfforts, chatPermissions } from "../shared/ide-chat.js";

const scopeSchema = z.object({
  hostId: z.string(),
  hostKey: z.string().length(64),
  nativeId: z.string(),
  provider: z.enum(["codex", "claude", "antigravity"]),
});
const entrySchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1).max(64000),
  actor: z.string().max(256),
  state: z.enum(["queued", "sending", "blocked"]),
  notBefore: z.number().int().positive().optional(),
  accountKey: z.string().length(64).optional(),
});
const receiptSchema = z.object({
  actor: z.string().max(256),
  requestId: z.string().max(160),
  hash: z.string().length(64),
});
const recordSchema = z.object({
  version: z.literal(1),
  scope: scopeSchema,
  reviewOnly: z.boolean(),
  effort: z.enum(chatEfforts).optional(),
  permission: z.enum(chatPermissions).optional(),
  model: z.string().max(160).optional(),
  entries: z.array(entrySchema).max(20),
  receipts: z.array(receiptSchema).max(4000),
});
type Scope = z.infer<typeof scopeSchema>;
export type SavedReservation = z.infer<typeof entrySchema>;
export type ReservationReceipt = z.infer<typeof receiptSchema>;
export type ReservationRecord = z.infer<typeof recordSchema>;

/** Keyed by the actual native conversation and its SSH configuration. Never persists a device lease or credential. */
export class ReservationJournal {
  private readonly directory: string;
  constructor(root: string) {
    this.directory = join(root, "chat-reservations");
  }
  private filename(s: Scope) {
    const hash = createHash("sha256")
      .update(JSON.stringify([s.hostId, s.hostKey, s.provider, s.nativeId]))
      .digest("hex");
    return join(this.directory, hash + ".json");
  }
  read(scope: Scope) {
    const target = this.filename(scope);
    try {
      if (statSync(target).size > 12 * 1024 * 1024)
        throw Error("예약 기록의 크기를 확인하세요.");
      const saved = recordSchema.parse(
        JSON.parse(readFileSync(target, "utf8")),
      );
      if (this.filename(saved.scope) !== target)
        throw Error("예약 기록의 대화 ID가 일치하지 않습니다.");
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw Error("이 대화의 예약 기록을 읽을 수 없습니다.");
    }
  }
  write(record: ReservationRecord) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.filename(record.scope),
      tmp = file + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw error;
    }
  }
}
