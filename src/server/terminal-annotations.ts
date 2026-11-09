import { z } from "zod";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ANNOTATION_COMMENT_LIMIT,
  ANNOTATION_DRAFT_LIMIT,
  ANNOTATION_DRAFT_TEXT_LIMIT,
  ANNOTATION_PROMPT_LIMIT,
  ANNOTATION_TEXT_LIMIT,
  annotationReference,
  type AnnotationCapture,
  type AnnotationComment,
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
export const annotationCommentsSchema = z
  .array(
    z
      .object({
        number: numberSchema,
        annotation: z.string().max(ANNOTATION_COMMENT_LIMIT),
      })
      .strict(),
  )
  .min(1)
  .max(ANNOTATION_DRAFT_LIMIT)
  .refine(
    (comments) =>
      new Set(comments.map((item) => item.number)).size === comments.length,
    "인용 번호가 중복되었습니다.",
  );

interface StoredAnnotation extends AnnotationCapture {
  readonly annotation: string;
  readonly submitted?: true;
  readonly sessionId?: string;
  readonly reference: string;
  readonly bytes: number;
}
interface Namespace {
  sessionId?: string;
  records: Map<number, StoredAnnotation>;
}

/** Private selections, available only to the originating native CLI session. */
export class TerminalAnnotations {
  private namespaces = new Map<string, Namespace>();
  // A global sequence also keeps each terminal's numbers increasing after revoke.
  // No tombstones or reused reference numbers are needed for deleted namespaces.
  private nextNumber = 1;
  private recordCount = 0;
  private byteCount = 0;
  private readonly file?: string;
  constructor(directory?: string) {
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "terminal-annotations.json");
    try {
      if (statSync(this.file).size > 8 * 1024 * 1024)
        throw new Error("Annotation snapshot is too large");
      const recordSchema = annotationCaptureSchema
        .extend({
          number: numberSchema,
          annotation: z.string().max(ANNOTATION_COMMENT_LIMIT),
          sessionId: idSchema.optional(),
          submitted: z.literal(true).optional(),
        })
        .strict();
      const data = z
        .object({
          version: z.literal(1),
          nextNumber: numberSchema,
          namespaces: z
            .array(
              z
                .object({
                  terminalId: idSchema,
                  sessionId: idSchema.optional(),
                  records: z.array(recordSchema).max(ANNOTATION_RECORD_LIMIT),
                })
                .strict(),
            )
            .max(ANNOTATION_RECORD_LIMIT),
        })
        .strict()
        .parse(JSON.parse(readFileSync(this.file, "utf8")));
      const numbers = new Set<number>();
      for (const namespace of data.namespaces) {
        if (this.namespaces.has(namespace.terminalId))
          throw new Error("Duplicate annotation namespace");
        const records = new Map<number, StoredAnnotation>();
        for (const saved of namespace.records) {
          if (numbers.has(saved.number) || saved.number >= data.nextNumber)
            throw new Error("Invalid annotation sequence");
          numbers.add(saved.number);
          const reference = annotationReference(saved.number);
          const source = Object.freeze(saved.source);
          const bytes = Buffer.byteLength(
            JSON.stringify({
              reference,
              text: saved.text,
              annotation: saved.annotation,
              source,
            }),
            "utf8",
          );
          const { number: _number, ...record } = saved;
          records.set(
            saved.number,
            Object.freeze({ ...record, source, reference, bytes }),
          );
          this.recordCount++;
          this.byteCount += bytes;
        }
        this.namespaces.set(namespace.terminalId, {
          sessionId: namespace.sessionId,
          records,
        });
      }
      if (
        this.recordCount > ANNOTATION_RECORD_LIMIT ||
        this.byteCount > ANNOTATION_BYTE_LIMIT
      )
        throw new Error("Annotation capacity exceeded");
      this.nextNumber = data.nextNumber;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "저장된 인용 정보를 읽지 못했습니다. 잘못된 번호로 연결하지 않도록 자동 초기화하지 않습니다. 개인 데이터 폴더의 terminal-annotations.json을 확인하세요.",
        );
    }
  }
  private save() {
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    const namespaces = [...this.namespaces].map(([terminalId, namespace]) => ({
      terminalId,
      ...(namespace.sessionId ? { sessionId: namespace.sessionId } : {}),
      records: [...namespace.records].map(([number, record]) => ({
        number,
        text: record.text,
        annotation: record.annotation,
        source: record.source,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.submitted ? { submitted: true } : {}),
      })),
    }));
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, nextNumber: this.nextNumber, namespaces }),
      { mode: 0o600 },
    );
    renameSync(temporary, this.file);
  }
  /** Remove departed terminals without ever reusing their reference numbers. */
  retain(terminalIds: ReadonlySet<string>) {
    for (const id of this.namespaces.keys())
      if (!terminalIds.has(id)) this.revoke(id);
  }

  /** Trusted wrapper/MCP readiness allows capture before deferred SessionStart. */
  prepare(terminalId: string): void {
    idSchema.parse(terminalId);
    const existing = this.namespaces.get(terminalId);
    if (existing) {
      // A fresh managed handshake must confirm the active native session again.
      // Previously assigned references retain their original session binding.
      existing.sessionId = undefined;
      this.save();
      return;
    }
    if (this.namespaces.size >= ANNOTATION_RECORD_LIMIT)
      throw new Error(
        "인용을 연결한 터미널이 너무 많습니다. 사용하지 않는 터미널을 닫아주세요.",
      );
    this.namespaces.set(terminalId, { records: new Map() });
    this.save();
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
      this.save();
      return;
    }
    if (this.namespaces.size >= ANNOTATION_RECORD_LIMIT)
      throw new Error(
        "인용을 연결한 터미널이 너무 많습니다. 사용하지 않는 터미널을 닫아주세요.",
      );
    this.namespaces.set(terminalId, { sessionId, records: new Map() });
    this.save();
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
        annotation: "",
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
        annotation: "",
        source,
        sessionId: namespace.sessionId,
        reference,
        bytes,
      }),
    );
    this.recordCount++;
    this.byteCount += bytes;
    this.save();
    return Object.freeze({ number, reference });
  }

  /** Check all refs before placing their markers in the CLI's real input. */
  validate(terminalId: string, numbers: readonly number[]): void {
    this.records(terminalId, numbers);
  }

  /** Attach notes atomically; a submitted marker always retains its original note. */
  attach(terminalId: string, input: readonly AnnotationComment[]): void {
    const comments = annotationCommentsSchema.parse(input);
    const records = this.records(
      terminalId,
      comments.map((item) => item.number),
      false,
    );
    const updated = records.map((record, index) => {
      const annotation = comments[index].annotation;
      if (record.submitted && record.annotation !== annotation)
        throw new Error(
          "이미 전송한 인용의 주석은 수정할 수 없습니다. 새로 선택해 추가해주세요.",
        );
      const bytes = Buffer.byteLength(
        JSON.stringify({
          reference: record.reference,
          text: record.text,
          annotation,
          source: record.source,
        }),
        "utf8",
      );
      return Object.freeze({ ...record, annotation, bytes });
    });
    this.validateDraftSize(updated);
    const additionalBytes = updated.reduce(
      (total, record, index) => total + record.bytes - records[index].bytes,
      0,
    );
    if (this.byteCount + additionalBytes > ANNOTATION_BYTE_LIMIT)
      throw new Error(
        "인용 저장 공간이 가득 찼습니다. 사용하지 않는 참조를 삭제하거나 터미널을 닫으세요.",
      );
    const namespace = this.ready(terminalId);
    for (let index = 0; index < updated.length; index++)
      namespace.records.set(comments[index].number, updated[index]);
    this.byteCount += additionalBytes;
    this.save();
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
    for (let index = 0; index < records.length; index++)
      if (!records[index].submitted)
        namespace.records.set(
          numbers[index],
          Object.freeze({ ...records[index], submitted: true }),
        );
    this.save();
    return Object.freeze({
      annotations: Object.freeze(
        records.map((record) =>
          Object.freeze({
            reference: record.reference,
            text: record.text,
            annotation: record.annotation,
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
    this.save();
  }

  revoke(terminalId: string): void {
    const namespace = this.namespaces.get(terminalId);
    if (!namespace) return;
    for (const record of namespace.records.values()) {
      this.recordCount--;
      this.byteCount -= record.bytes;
    }
    this.namespaces.delete(terminalId);
    this.save();
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
    checkDraftSize = true,
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
    if (checkDraftSize) this.validateDraftSize(records);
    return records;
  }

  private validateDraftSize(records: readonly StoredAnnotation[]): void {
    if (
      records.reduce(
        (total, record) =>
          total + record.text.length + record.annotation.length,
        0,
      ) > ANNOTATION_DRAFT_TEXT_LIMIT
    )
      throw new Error(
        `전체 인용은 ${ANNOTATION_DRAFT_TEXT_LIMIT.toLocaleString()}자까지 가능합니다. 일부 참조를 삭제해주세요.`,
      );
  }
}
