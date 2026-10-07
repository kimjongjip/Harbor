import { z } from "zod";
import {
  ANNOTATION_DRAFT_LIMIT,
  ANNOTATION_DRAFT_TEXT_LIMIT,
  ANNOTATION_PROMPT_LIMIT,
  ANNOTATION_TEXT_LIMIT,
  annotationReference,
  type AnnotationCapture,
  type AnnotationContext,
  type AnnotationReference,
} from "../shared/annotations.js";

// These are process-wide limits, not multiplied by the number of terminals.
export const ANNOTATION_RECORD_LIMIT = 256;
export const ANNOTATION_BYTE_LIMIT = 2 * 1024 * 1024;

const idSchema = z.string().min(1).max(256);
const numberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sourceSchema = z
  .object({
    hostName: z.string().min(1).max(300),
    title: z.string().min(1).max(300),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict();

/** Bound the HTTP capture payload without changing the selected text. */
export const annotationCaptureSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(ANNOTATION_TEXT_LIMIT)
      .refine((text) => Boolean(text.trim()), "인용할 글을 먼저 선택해주세요."),
    source: sourceSchema,
  })
  .strict();
export const annotationNumbersSchema = z
  .array(numberSchema)
  .min(1)
  .max(ANNOTATION_DRAFT_LIMIT)
  .refine(
    (numbers) => new Set(numbers).size === numbers.length,
    "인용 번호가 중복되었습니다.",
  );

interface StoredAnnotation extends AnnotationCapture {
  readonly sessionId?: string;
  readonly reference: string;
  readonly bytes: number;
}
interface Namespace {
  sessionId?: string;
  records: Map<number, StoredAnnotation>;
}

/** In-memory selections, available only to the originating native CLI session. */
export class TerminalAnnotations {
  private namespaces = new Map<string, Namespace>();
  // A global sequence also keeps each terminal's numbers increasing after revoke.
  // No tombstones or reused reference numbers are needed for deleted namespaces.
  private nextNumber = 1;
  private recordCount = 0;
  private byteCount = 0;

  /** Trusted wrapper/MCP readiness allows capture before deferred SessionStart. */
  prepare(terminalId: string): void {
    idSchema.parse(terminalId);
    const existing = this.namespaces.get(terminalId);
    if (existing) {
      // A fresh managed handshake must confirm the active native session again.
      // Previously assigned references retain their original session binding.
      existing.sessionId = undefined;
      return;
    }
    if (this.namespaces.size >= ANNOTATION_RECORD_LIMIT)
      throw new Error(
        "인용을 연결한 터미널이 너무 많습니다. 사용하지 않는 터미널을 닫아주세요.",
      );
    this.namespaces.set(terminalId, { records: new Map() });
  }

  markReady(terminalId: string, sessionId: string): void {
    idSchema.parse(terminalId);
    idSchema.parse(sessionId);
    const existing = this.namespaces.get(terminalId);
    if (existing) {
      if (!existing.sessionId) {
        // Bind pending captures once, without modifying their selected data.
        for (const [number, record] of existing.records) {
          if (!record.sessionId)
            existing.records.set(
              number,
              Object.freeze({ ...record, sessionId }),
            );
        }
      }
      // Keep old records bound to their original session so stale markers fail.
      existing.sessionId = sessionId;
      return;
    }
    if (this.namespaces.size >= ANNOTATION_RECORD_LIMIT)
      throw new Error(
        "인용을 연결한 터미널이 너무 많습니다. 사용하지 않는 터미널을 닫아주세요.",
      );
    this.namespaces.set(terminalId, { sessionId, records: new Map() });
  }

  isReady(terminalId: string): boolean {
    return this.namespaces.has(terminalId);
  }

  capture(terminalId: string, input: AnnotationCapture): AnnotationReference {
    const namespace = this.ready(terminalId);
    const parsed = annotationCaptureSchema.parse(input);
    const reference = annotationReference(this.nextNumber);
    const source = Object.freeze({ ...parsed.source });
    const bytes = Buffer.byteLength(
      JSON.stringify({
        reference,
        text: parsed.text,
        source,
      }),
      "utf8",
    );
    if (
      this.recordCount >= ANNOTATION_RECORD_LIMIT ||
      this.byteCount + bytes > ANNOTATION_BYTE_LIMIT
    )
      throw new Error(
        "인용 저장 공간이 가득 찼습니다. 사용하지 않는 참조를 삭제하거나 터미널을 닫아주세요.",
      );
    const number = this.nextNumber++;
    namespace.records.set(
      number,
      Object.freeze({
        text: parsed.text,
        source,
        sessionId: namespace.sessionId,
        reference,
        bytes,
      }),
    );
    this.recordCount++;
    this.byteCount += bytes;
    return Object.freeze({ number, reference });
  }

  /** Check all refs before placing their markers in the CLI's real input. */
  validate(terminalId: string, numbers: readonly number[]): void {
    this.records(terminalId, numbers);
  }

  /** Ordinary prompts add no context. Markers must resolve in this native session. */
  resolve(
    terminalId: string,
    prompt: string,
    sessionId: string,
  ): AnnotationContext | null {
    if (typeof prompt !== "string" || prompt.length > ANNOTATION_PROMPT_LIMIT)
      throw new Error("인용을 확인할 입력이 너무 깁니다.");
    const numbers: number[] = [];
    for (const marker of prompt.matchAll(/\[#([0-9]+) annotation\]/g)) {
      const number = Number(marker[1]);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        String(number) !== marker[1]
      )
        throw new Error("인용 번호가 올바르지 않습니다.");
      if (!numbers.includes(number)) numbers.push(number);
      if (numbers.length > ANNOTATION_DRAFT_LIMIT)
        throw new Error(
          `인용은 한 번에 ${ANNOTATION_DRAFT_LIMIT}개까지 가능합니다.`,
        );
    }
    if (!numbers.length) return null;
    const namespace = this.ready(terminalId);
    if (!namespace.sessionId) {
      // Some managed reconnects do not emit SessionStart again. This method is
      // called only by the authenticated native UserPromptSubmit hook.
      this.markReady(terminalId, idSchema.parse(sessionId));
    }
    if (namespace.sessionId !== sessionId)
      throw new Error(
        "인용을 추가한 대화와 현재 대화가 다릅니다. 현재 대화에서 다시 선택해주세요.",
      );
    const records = this.records(terminalId, numbers);
    return Object.freeze({
      annotations: Object.freeze(
        records.map((record) =>
          Object.freeze({
            reference: record.reference,
            text: record.text,
            source: record.source,
          }),
        ),
      ),
    });
  }

  /** Explicitly removed refs cannot later resolve to replacement text. */
  remove(terminalId: string, numbers: readonly number[]): void {
    const namespace = this.namespaces.get(terminalId);
    if (!namespace) return;
    for (const number of numbers) {
      numberSchema.parse(number);
      const record = namespace.records.get(number);
      if (!record) continue;
      namespace.records.delete(number);
      this.recordCount--;
      this.byteCount -= record.bytes;
    }
  }

  revoke(terminalId: string): void {
    const namespace = this.namespaces.get(terminalId);
    if (!namespace) return;
    for (const record of namespace.records.values()) {
      this.recordCount--;
      this.byteCount -= record.bytes;
    }
    this.namespaces.delete(terminalId);
  }

  private ready(terminalId: string): Namespace {
    const namespace = this.namespaces.get(terminalId);
    if (!namespace)
      throw new Error(
        "이 터미널의 인용 연동이 준비되지 않았습니다. CLI 연결을 확인해주세요.",
      );
    return namespace;
  }

  private records(
    terminalId: string,
    numbers: readonly number[],
  ): StoredAnnotation[] {
    const namespace = this.ready(terminalId);
    const parsed = annotationNumbersSchema.parse(numbers);
    const records = parsed.map((number) => {
      const record = namespace.records.get(number);
      if (!record)
        throw new Error(
          `${annotationReference(number)} 참조를 찾을 수 없습니다. 현재 터미널에서 다시 선택해주세요.`,
        );
      if (record.sessionId !== namespace.sessionId)
        throw new Error(
          "인용을 추가한 뒤 대화가 변경되었습니다. 현재 대화에서 다시 선택해주세요.",
        );
      return record;
    });
    if (
      records.reduce((total, record) => total + record.text.length, 0) >
      ANNOTATION_DRAFT_TEXT_LIMIT
    )
      throw new Error(
        `전체 인용은 ${ANNOTATION_DRAFT_TEXT_LIMIT.toLocaleString()}자까지 가능합니다. 일부 참조를 삭제해주세요.`,
      );
    return records;
  }
}
