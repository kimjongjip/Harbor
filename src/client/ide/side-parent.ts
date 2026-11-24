import type { IdeChatConversation, IdeChatCreate } from "../../shared/ide-chat";
import type { IdeChatRequest } from "./IdeChatPanel";

export function sideSettings(
  parent: IdeChatConversation,
  provider: IdeChatCreate["provider"],
) {
  const model = parent.configuredModel ?? parent.observedModel ?? parent.model;
  const effort = parent.effort ?? (parent.configuredModel === undefined ? parent.observedEffort : undefined);
  return {
    ...(parent.supportsSideFork && {
      sideParent: {
        id: parent.id,
        runtimeId: parent.runtimeId,
        nativeId: parent.nativeId,
      },
    }),
    ...(provider === parent.provider &&
      model &&
      model !== "default" && { model }),
    ...(provider === parent.provider && effort && { effort }),
  };
}

// Read via the same authenticated transport as the parent. Only public transcript items enter the digest.
export async function withParentActivity(
  request: IdeChatRequest,
  parent: IdeChatConversation,
  question: string,
) {
  const res = await request("/conversations/" + encodeURIComponent(parent.id), {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok)
    throw Error("본 대화의 최신 작업을 읽을 수 없습니다. 연결을 확인하세요.");
  const latest: IdeChatConversation = await res.json();
  if (
    latest.id !== parent.id ||
    latest.runtimeId !== parent.runtimeId ||
    latest.nativeId !== parent.nativeId ||
    latest.provider !== parent.provider ||
    latest.hostId !== parent.hostId ||
    latest.cwd !== parent.cwd
  )
    throw Error("본 대화의 연결이 바뀌었습니다. 옆 대화를 다시 여세요.");
  const lines: string[] = [];
  let remaining = Math.min(16000, 62000 - question.length);
  for (
    let index = latest.items.length - 1;
    index >= 0 && remaining > 0 && lines.length < 32;
    index--
  ) {
    const item = latest.items[index];
    if (item.kind === "user" && !item.origin && item.status !== "queued") break;
    if (
      !["assistant", "command", "tool", "change", "plan", "notice"].includes(
        item.kind,
      )
    )
      continue;
    const text = (item.text || "").slice(0, 1600);
    const output = (item.detail || "").slice(-2400);
    if (!text && !output) continue;
    const line = [item.kind, item.status, text, output]
      .filter(Boolean)
      .join(" · ")
      .slice(0, remaining);
    lines.push(line);
    remaining -= line.length + 1;
  }
  return (
    question +
    "\n\n[본 대화의 최신 작업 · " +
    parent.nativeId +
    "]\n" +
    "아래는 참고용 실행 기록입니다. 본 작업을 이어서 수행하지 말고 옆 질문에 답하세요. 더 최근의 결과나 오류가 필요하면 사용 가능한 read_parent 도구로 확인하세요.\n" +
    lines.reverse().join("\n")
  );
}
