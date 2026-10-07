import { useEffect, useId, useRef, useState } from "react";
import { Quote, X } from "lucide-react";
import type { TerminalAnnotationReference } from "./terminalAnnotation";
import "./terminal-annotation.css";

export function TerminalAnnotationDialog({
  annotations,
  onRemove,
  onClose,
  onInsert,
  disabled,
}: {
  annotations: readonly TerminalAnnotationReference[];
  onRemove: (number: number) => void;
  onClose: () => void;
  onInsert: (question: string) => Promise<string | null>;
  disabled: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [expandedNumber, setExpandedNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const expanded = annotations.find((item) => item.number === expandedNumber);
  const canInsert = !disabled && !busy && annotations.length > 0;

  useEffect(() => {
    mounted.current = true;
    const frame = requestAnimationFrame(() => questionRef.current?.focus());
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  const insert = async () => {
    if (!canInsert || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await onInsert(question.trim());
      if (mounted.current) setError(result);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "입력하지 못했습니다. 연결 상태를 확인해 주세요.",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section
      className="terminal-annotation-dock"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="terminal-annotation-header">
        <Quote size={15} aria-hidden="true" />
        <strong id={`${id}-title`}>인용하여 질문</strong>
        <button
          type="button"
          className="icon-button compact"
          aria-label="인용하여 질문 닫기"
          title="닫기 (Esc)"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <form
        className="terminal-annotation-form"
        onSubmit={(event) => {
          event.preventDefault();
          insert();
        }}
      >
        <div className="terminal-annotation-attachments" aria-label="인용 첨부">
          {annotations.map((annotation) => {
            const label = `[#${annotation.number} annotation]`;
            const isExpanded = expanded?.number === annotation.number;
            return (
              <div
                className={`terminal-annotation-chip ${isExpanded ? "expanded" : ""}`}
                key={annotation.number}
              >
                <button
                  type="button"
                  className="terminal-annotation-chip-label"
                  aria-expanded={isExpanded}
                  aria-controls={isExpanded ? `${id}-preview` : undefined}
                  title="선택한 내용 확인"
                  onClick={() =>
                    setExpandedNumber(isExpanded ? null : annotation.number)
                  }
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="terminal-annotation-chip-remove"
                  aria-label={`${label} 제거`}
                  title="인용 제거"
                  disabled={busy}
                  onClick={() => {
                    if (isExpanded) setExpandedNumber(null);
                    onRemove(annotation.number);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {annotations.length === 0 && (
            <p className="terminal-annotation-hint">
              터미널에서 글을 선택해 인용을 추가하세요.
            </p>
          )}
        </div>
        {expanded && (
          <section className="terminal-annotation-preview" id={`${id}-preview`}>
            <div className="terminal-annotation-source">
              <span>
                {expanded.snapshot.source.hostName} ·{" "}
                {expanded.snapshot.source.title}
              </span>
              {expanded.snapshot.startLine != null && (
                <span>
                  터미널 버퍼 {expanded.snapshot.startLine}
                  {expanded.snapshot.endLine != null &&
                  expanded.snapshot.endLine !== expanded.snapshot.startLine
                    ? `–${expanded.snapshot.endLine}`
                    : ""}
                  행
                </span>
              )}
            </div>
            <pre className="terminal-annotation-quote">
              {expanded.snapshot.text}
            </pre>
          </section>
        )}
        <label
          className="terminal-annotation-question"
          htmlFor={`${id}-question`}
        >
          <span className="terminal-annotation-label">질문</span>
          <textarea
            aria-label="인용에 대한 질문"
            id={`${id}-question`}
            ref={questionRef}
            value={question}
            maxLength={8000}
            rows={2}
            disabled={busy}
            placeholder="질문은 여기 또는 CLI 입력칸에서 작성하세요. (선택 사항)"
            onChange={(event) => {
              setQuestion(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.stopPropagation();
                insert();
              }
            }}
          />
        </label>
        <p className="terminal-annotation-hint">
          입력칸에는 인용 번호만 표시됩니다. 선택한 내용은 전송할 때 별도로
          연결됩니다. 터미널에서 Enter를 눌러 보내세요.
        </p>
        {disabled && (
          <p className="terminal-annotation-error" role="status">
            터미널 연결을 기다리고 있습니다. 작성한 질문은 유지됩니다.
          </p>
        )}
        {error && (
          <p className="terminal-annotation-error" role="alert">
            {error}
          </p>
        )}
        <footer className="terminal-annotation-footer">
          <span className="terminal-annotation-hint">Ctrl+Enter</span>
          <button
            type="button"
            className="button secondary small"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="submit"
            className="button primary small"
            disabled={!canInsert}
          >
            {busy ? "연결 확인 중…" : "입력에 추가"}
          </button>
        </footer>
      </form>
    </section>
  );
}
