import { useEffect, useId, useRef, useState } from "react";
import { Quote } from "lucide-react";
import { Modal } from "./Dialogs";
import type { TerminalAnnotationSnapshot } from "./terminalAnnotation";
import "./terminal-annotation.css";

export function TerminalAnnotationDialog({
  annotation,
  onClose,
  onInsert,
  disabled,
}: {
  annotation: TerminalAnnotationSnapshot;
  onClose: () => void;
  onInsert: (question: string, includeContext: boolean) => string | null;
  disabled: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const hasContext = Boolean(annotation.before || annotation.after);
  useEffect(() => {
    const frame = requestAnimationFrame(() => questionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const insert = () => {
    if (disabled || !question.trim()) return;
    try {
      setError(onInsert(question.trim(), hasContext && includeContext));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "입력하지 못했습니다. 연결 상태를 확인해주세요.",
      );
    }
  };
  return (
    <div className="terminal-annotation-shell">
      <Modal
        title="선택한 부분에 질문"
        subtitle="인용할 내용과 문맥을 확인하고 질문을 작성하세요."
        onClose={onClose}
        wide
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            insert();
          }}
        >
          <div className="modal-body terminal-annotation-body">
            <section
              className="terminal-annotation-card"
              aria-label="선택한 내용과 출처"
            >
              <header>
                <Quote size={16} />
                <strong>터미널에서 선택한 내용</strong>
              </header>
              <div className="terminal-annotation-source">
                <span>
                  {annotation.source.hostName} · {annotation.source.title}
                </span>
                <time dateTime={annotation.capturedAt}>
                  {new Date(annotation.capturedAt).toLocaleString()}
                </time>
              </div>
              <pre className="terminal-annotation-quote">{annotation.text}</pre>
              <details className="terminal-annotation-origin">
                <summary>출처 상세</summary>
                <dl>
                  <dt>터미널</dt>
                  <dd>{annotation.source.terminalId}</dd>
                  {annotation.source.threadId && (
                    <>
                      <dt>대화</dt>
                      <dd>{annotation.source.threadId}</dd>
                    </>
                  )}
                  {annotation.startLine != null && (
                    <>
                      <dt>선택 당시 버퍼 줄</dt>
                      <dd>
                        {annotation.startLine}–
                        {annotation.endLine ?? annotation.startLine}
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            </section>
            {hasContext ? (
              <section className="terminal-annotation-context">
                <label className="terminal-annotation-context-toggle">
                  <input
                    type="checkbox"
                    checked={includeContext}
                    onChange={(event) =>
                      setIncludeContext(event.target.checked)
                    }
                  />
                  주변 문맥 함께 넣기
                </label>
                <details>
                  <summary>
                    앞뒤 내용 확인{" "}
                    {includeContext ? "· 입력에 포함" : "· 입력에서 제외"}
                  </summary>
                  {annotation.before && (
                    <>
                      <h4>선택 부분 앞</h4>
                      <pre>{annotation.before}</pre>
                    </>
                  )}
                  {annotation.after && (
                    <>
                      <h4>선택 부분 뒤</h4>
                      <pre>{annotation.after}</pre>
                    </>
                  )}
                </details>
                {annotation.contextTruncated && (
                  <p className="terminal-annotation-hint">
                    주변 문맥이 길어 일부만 포함합니다. 위에 표시된 내용이
                    입력됩니다.
                  </p>
                )}
              </section>
            ) : (
              <p className="terminal-annotation-hint">
                이 선택에서 확인할 수 있는 주변 문맥이 없어 선택한 내용만
                인용합니다.
              </p>
            )}
            <label className="field terminal-annotation-question" htmlFor={id}>
              질문
              <textarea
                aria-label="인용에 대한 질문"
                id={id}
                ref={questionRef}
                value={question}
                maxLength={8000}
                rows={4}
                placeholder="이 부분에서 궁금한 점이나 바꾸고 싶은 내용을 적으세요."
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
                    insert();
                  }
                }}
              />
            </label>
            <p className="terminal-annotation-hint">
              {question.length.toLocaleString()} / 8,000자 · Ctrl+Enter로 입력
            </p>
            {disabled && (
              <p className="form-error" role="status">
                터미널 연결을 기다리고 있습니다. 질문은 그대로 유지됩니다.
              </p>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
          </div>
          <footer className="modal-footer terminal-annotation-footer">
            <p>
              인용과 질문을 CLI의 현재 입력에 추가합니다.
              <br />
              내용을 확인한 뒤 터미널에서 Enter로 전송하세요.
            </p>
            <div>
              <button type="button" className="button" onClick={onClose}>
                취소
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={disabled || !question.trim()}
              >
                인용과 질문 입력
              </button>
            </div>
          </footer>
        </form>
      </Modal>
    </div>
  );
}
