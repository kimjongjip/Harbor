import { useMemo } from "react";
import type { MessageItem } from "../../shared/types";
import { stepTitle, transcriptEntries } from "../transcript-steps";
import { typedPrompt } from "../user-origin";

function latestActivity(items: MessageItem[], cwd: string) {
  let start = items.length;
  while (start > 0 && !typedPrompt(items[start - 1])) start--;
  const records = start ? items.slice(start) : items;
  const entry = transcriptEntries(records).at(-1);
  if (!entry) return;
  if (entry.kind === "commentary")
    return { label: "중간 보고", title: "", detail: "" };
  if (entry.kind === "message")
    return entry.item.kind === "assistant" && entry.item.status === "inProgress"
      ? { label: "답변 작성 중", title: "", detail: "" }
      : undefined;
  if (entry.kind === "step") {
    const { name, target } = stepTitle(entry.call, cwd);
    return {
      label: entry.result ? "최근 작업" : "실행 중",
      title: [name, target].filter(Boolean).join(" · "),
      detail: entry.result?.detail || "",
    };
  }
  if (entry.kind !== "item" || entry.item.kind === "notice") return;
  const { kind, text, detail, status } = entry.item;
  const name =
    kind === "command"
      ? "명령"
      : kind === "change"
        ? "파일 변경"
        : kind === "plan"
          ? "계획"
          : "";
  return {
    label:
      status === "inProgress" || status === "started" ? "실행 중" : "최근 작업",
    title: [name, text].filter(Boolean).join(" · "),
    detail: detail || "",
  };
}

/** Uses only records from this conversation. The full output stays in its transcript. */
export function ManagedActivity({
  items,
  cwd,
  preview = false,
}: {
  items: MessageItem[];
  cwd: string;
  preview?: boolean;
}) {
  const activity = useMemo(() => latestActivity(items, cwd), [items, cwd]);
  const detail =
    preview &&
    activity?.detail.trim().slice(-400).split("\n").slice(-2).join("\n");
  const title = activity?.title.replace(/\s+/g, " ").trim().slice(0, 200);
  return (
    <div className="ide-chat-progress" aria-label="현재 작업">
      <span>{activity?.label || "다음 작업 기록 대기 중"}</span>
      {title && <strong title={title}>{title}</strong>}
      {detail && <pre>{detail}</pre>}
    </div>
  );
}
