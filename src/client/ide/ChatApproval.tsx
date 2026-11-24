import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { Approval } from "../../shared/types";
import type { IdeChatAnswer } from "../../shared/ide-chat";

export function ApprovalCard({
  approval,
  onAnswer,
  questionsOnly = false,
}: {
  approval: Approval;
  questionsOnly?: boolean;
  onAnswer: (answer: Omit<IdeChatAnswer, "runtimeId">) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function answer(value: Omit<IdeChatAnswer, "runtimeId">) {
    setBusy(true);
    setError("");
    try {
      await onAnswer(value);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ide-chat-approval" aria-label="AI 확인 요청">
      <strong>
        <ShieldCheck size={15} />
        {approval.title}
      </strong>
      {approval.detail && <pre>{approval.detail}</pre>}
      {approval.kind === "question" &&
        approval.questions?.map((question) => (
          <div className="ide-chat-question" key={question.id}>
            <span>{question.question}</span>
            <div>
              {question.options?.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  title={option.description}
                  aria-pressed={answers[question.id] === option.label}
                  onClick={() =>
                    setAnswers((old) => ({
                      ...old,
                      [question.id]: option.label,
                    }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <input
              aria-label={question.question}
              value={answers[question.id] || ""}
              onChange={(event) =>
                setAnswers((old) => ({
                  ...old,
                  [question.id]: event.target.value,
                }))
              }
            />
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
      <div className="ide-chat-approval-actions">
        {approval.kind !== "question" && (
          <button
            disabled={busy}
            onClick={() => void answer({ approved: false })}
          >
            거절
          </button>
        )}
        {(!questionsOnly || approval.kind === "question") && (
          <button
            disabled={
              busy ||
              approval.kind === "unsupported" ||
              (approval.kind === "question" &&
                !!approval.questions?.some(
                  (question) => !answers[question.id]?.trim(),
                ))
            }
            onClick={() =>
              void answer(
                approval.kind === "question" ? { answers } : { approved: true },
              )
            }
          >
            {busy
              ? "전송 중…"
              : approval.kind === "question"
                ? "답변 보내기"
                : "이번만 허용"}
          </button>
        )}
      </div>
    </section>
  );
}
