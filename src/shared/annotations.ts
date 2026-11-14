export const ANNOTATION_TEXT_LIMIT = 16_000;
export const ANNOTATION_COMMENT_LIMIT = 8_000;
export const ANNOTATION_DRAFT_TEXT_LIMIT = 64_000;
export const ANNOTATION_DRAFT_LIMIT = 8;
export const ANNOTATION_PROMPT_LIMIT = 128_000;

export interface AnnotationSource {
  readonly hostName: string;
  readonly title: string;
  readonly cwd?: string;
}

export interface AnnotationCapture {
  readonly text: string;
  readonly source: AnnotationSource;
}

/** The selected text remains on the server; only this marker enters the CLI. */
export interface AnnotationReference {
  readonly number: number;
  readonly displayNumber?: number;
  readonly reference: string;
}

/** A note attached to one selection, hidden behind its CLI marker. */
export interface AnnotationComment {
  readonly number: number;
  readonly annotation: string;
}

export interface AnnotationContext {
  readonly annotations: readonly {
    readonly reference: string;
    readonly text: string;
    readonly annotation: string;
    readonly source: AnnotationSource;
  }[];
}

export function annotationReference(
  number: number,
  displayNumber?: number,
): string {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("인용 번호가 올바르지 않습니다.");
  if (
    displayNumber !== undefined &&
    (!Number.isSafeInteger(displayNumber) || displayNumber < 1)
  )
    throw new Error("인용 표시 번호가 올바르지 않습니다.");
  // Keep the first marker recognizable by hooks in already-running CLI sessions.
  return displayNumber === undefined
    ? `[#${number} annotation]`
    : `[#${displayNumber} annotation][ref:${number}]`;
}
