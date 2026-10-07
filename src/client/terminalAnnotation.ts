import type { Terminal } from "@xterm/xterm";

export interface TerminalAnnotationSource {
  terminalId: string;
  hostName: string;
  title: string;
  threadId?: string;
  cwd?: string;
}

export interface TerminalAnnotationSnapshot {
  readonly text: string;
  readonly source: Readonly<TerminalAnnotationSource>;
  readonly capturedAt: string;
  /** One-based terminal buffer rows, not file or conversation line numbers. */
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface TerminalAnnotationReference {
  readonly number: number;
  readonly snapshot: TerminalAnnotationSnapshot;
}

export const annotationLimit = 8;
export const annotationUnavailable =
  "번호 인용 연결이 준비되지 않았습니다. Harbor 업데이트 후 Codex를 다시 실행해주세요.";

export function annotationApiError(error: unknown): string {
  if (error instanceof SyntaxError) return annotationUnavailable;
  const message = error instanceof Error ? error.message : String(error || "");
  if (
    !message ||
    /^(?:요청 실패 \(404\)|요청한 기능을 찾을 수 없습니다\.?|Cannot POST \/api\/.*|404(?: Not Found)?)$/i.test(
      message,
    )
  )
    return annotationUnavailable;
  return message;
}

export function annotationLabel(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("인용 번호가 올바르지 않습니다.");
  return `[#${number} annotation]`;
}

/** Remove terminal instructions while retaining ordinary multiline prose. */
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function metadata(value: string): string {
  return stripTerminalControls(value).replace(/\s+/g, " ").trim();
}

export function snapshotTerminalAnnotation(
  term: Pick<Terminal, "getSelection" | "getSelectionPosition" | "buffer">,
  selectedText: string,
  source: TerminalAnnotationSource,
): TerminalAnnotationSnapshot {
  const text = stripTerminalControls(selectedText);
  if (!text.trim()) throw new Error("인용할 글을 먼저 선택해주세요.");
  if (text.length > 16_000)
    throw new Error("인용은 16,000자까지 가능합니다. 선택 범위를 줄여주세요.");

  let startLine: number | undefined;
  let endLine: number | undefined;
  // DOM selections and stale selections must never borrow unrelated terminal context.
  const position =
    term.getSelection() === selectedText
      ? term.getSelectionPosition()
      : undefined;
  const buffer = term.buffer.active;
  if (
    position &&
    position.start.y >= 0 &&
    position.start.y < buffer.length &&
    (position.end.y < buffer.length ||
      (position.end.y === buffer.length && position.end.x === 0))
  ) {
    const { start, end } = position;
    startLine = start.y + 1;
    // xterm's end coordinate is exclusive; a zero column belongs to the preceding row.
    const lastRow = end.x === 0 && end.y > start.y ? end.y - 1 : end.y;
    endLine = lastRow + 1;
  }
  const capturedSource = Object.freeze({
    terminalId: metadata(source.terminalId),
    hostName: metadata(source.hostName),
    title: metadata(source.title),
    ...(source.threadId ? { threadId: metadata(source.threadId) } : {}),
    ...(source.cwd ? { cwd: metadata(source.cwd) } : {}),
  });
  return Object.freeze({
    text,
    source: capturedSource,
    capturedAt: new Date().toISOString(),
    startLine,
    endLine,
  });
}

export function buildAnnotationPrompt(
  annotations: readonly TerminalAnnotationReference[],
  question: string,
): string {
  const cleanQuestion = stripTerminalControls(question).trim();
  if (cleanQuestion.length > 8_000)
    throw new Error("질문은 8,000자까지 가능합니다. 질문을 줄여주세요.");
  if (!annotations.length) throw new Error("인용할 글을 먼저 선택해주세요.");
  if (annotations.length > annotationLimit)
    throw new Error(`인용은 한 번에 ${annotationLimit}개까지 가능합니다.`);
  if (
    annotations.reduce((total, item) => total + item.snapshot.text.length, 0) >
    64_000
  )
    throw new Error(
      "전체 인용은 64,000자까지 가능합니다. 일부 참조를 삭제해주세요.",
    );
  const labels = annotations.map(({ number }) => annotationLabel(number));
  if (new Set(labels).size !== labels.length)
    throw new Error("인용 번호가 중복되었습니다.");
  for (const { snapshot } of annotations) {
    const quote = stripTerminalControls(snapshot.text);
    if (!quote.trim() || quote.length > 16_000)
      throw new Error(
        "인용 범위를 확인해주세요. 인용 하나는 16,000자까지 가능합니다.",
      );
  }
  // The server-side native hook supplies reference contents separately.
  // Never expose the quote body or provenance in the native composer.
  return [labels.join(" "), cleanQuestion].filter(Boolean).join("\n\n");
}
