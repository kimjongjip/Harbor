import { useEffect, useId, useRef, useState } from "react";
import { Quote, X } from "lucide-react";
import type { TerminalAnnotationReference } from "./terminalAnnotation";
import "./terminal-annotation.css";

export function TerminalAnnotationDialog({
  annotations,
  onRemove,
  onUpdateAnnotation,
  onClose,
  onInsert,
  disabled,
}: {
  annotations: readonly TerminalAnnotationReference[];
  onRemove: (number: number) => void;
  onUpdateAnnotation: (number: number, annotation: string) => void;
  onClose: () => void;
  onInsert: () => Promise<string | null>;
  disabled: boolean;
}) {
  const [selectedNumber, setSelectedNumber] = useState<number | null>(
    annotations.at(-1)?.number ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const previousNumbers = useRef(
    new Set(annotations.map((item) => item.number)),
  );
  const id = useId();
  const selected =
    annotations.find((item) => item.number === selectedNumber) ??
    annotations.at(-1);
  const selectedLabel = selected ? `[#${selected.number} annotation]` : "";
  const canInsert = !disabled && !busy && annotations.length > 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const added = annotations.filter(
      (item) => !previousNumbers.current.has(item.number),
    );
    const number = added.at(-1)?.number;
    if (number != null) {
      setSelectedNumber(number);
      setError(null);
    }
    previousNumbers.current = new Set(annotations.map((item) => item.number));
  }, [annotations]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => questionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selected?.number]);

  const insert = async () => {
    if (!canInsert || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await onInsert();
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
            const isSelected = selected?.number === annotation.number;
            return (
              <div
                className={`terminal-annotation-chip ${isSelected ? "expanded" : ""}`}
                key={annotation.number}
              >
                <button
                  type="button"
                  className="terminal-annotation-chip-label"
                  aria-pressed={isSelected}
                  aria-controls={`${id}-reference`}
                  title="인용문과 이 인용에 대한 질문·주석 확인"
                  onClick={() => {
                    setSelectedNumber(annotation.number);
                    setError(null);
                  }}
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
                    if (isSelected) setSelectedNumber(null);
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
        {selected && (
          <section
            className="terminal-annotation-reference"
            id={`${id}-reference`}
          >
            <div className="terminal-annotation-preview">
              <div className="terminal-annotation-source">
                <span>
                  {selected.snapshot.source.hostName} ·{" "}
                  {selected.snapshot.source.title}
                </span>
                {selected.snapshot.startLine != null && (
                  <span>
                    터미널 버퍼 {selected.snapshot.startLine}
                    {selected.snapshot.endLine != null &&
                    selected.snapshot.endLine !== selected.snapshot.startLine
                      ? `–${selected.snapshot.endLine}`
                      : ""}
                    행
                  </span>
                )}
              </div>
              <pre className="terminal-annotation-quote">
                {selected.snapshot.text}
              </pre>
            </div>
            <label
              className="terminal-annotation-question"
              htmlFor={`${id}-question`}
            >
              <span className="terminal-annotation-label">
                {selectedLabel}에 담을 질문·주석
              </span>
              <textarea
                aria-label={`${selectedLabel}에 대한 질문·주석`}
                id={`${id}-question`}
                ref={questionRef}
                value={selected.annotation}
                maxLength={8000}
                rows={2}
                disabled={busy}
                placeholder="이 인용문에 대해 하고 싶은 말을 적으세요."
                onChange={(event) => {
                  onUpdateAnnotation(selected.number, event.target.value);
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
          </section>
        )}
        <p className="terminal-annotation-hint">
          각 번호에 인용문과 질문·주석이 함께 담깁니다. CLI에는 번호만 추가되며,
          터미널에서 Enter를 눌러 보냅니다.
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
