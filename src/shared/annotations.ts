export const ANNOTATION_TEXT_LIMIT = 16_000;
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
  readonly reference: string;
}

export interface AnnotationContext {
  readonly annotations: readonly {
    readonly reference: string;
    readonly text: string;
    readonly source: AnnotationSource;
  }[];
}

export function annotationReference(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("인용 번호가 올바르지 않습니다.");
  return `[#${number} annotation]`;
}
