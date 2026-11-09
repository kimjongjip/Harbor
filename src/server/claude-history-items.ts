import type { MessageItem } from "../shared/types.js";

/** Projection of one native record; never retain image bytes or thinking blocks. */
export interface ClaudeHistoryRecord {
  id: string;
  parentId?: string;
  userId?: string;
  prompt: boolean;
  items: MessageItem[];
  outcome?: MessageItem["turnStatus"];
  activityOmitted?: boolean;
}

export function belongsToClaudeSession(row: any, sessionId: string): boolean {
  return !!row && typeof row === "object" && !Array.isArray(row) &&
    (!row.sessionId || row.sessionId === sessionId) &&
    (!row.session_id || row.session_id === sessionId) &&
    !row.isSidechain && !row.parent_tool_use_id && !row.agent_id;
}

const bounded = (value: unknown, length = 4000): string =>
  typeof value === "string" ? value.slice(0, length) : "";

function toolDescription(part: any): string {
  const input = part.input;
  if (!input || typeof input !== "object") return "";
  // Display only public work arguments, not arbitrary tool payloads or images.
  return ["command", "file_path", "path", "pattern", "query", "description", "target", "recipient", "message", "question", "prompt"]
    .flatMap(key => typeof input[key] === "string" ? [`${key}: ${input[key]}`] : [])
    .join("\n");
}

function toolResult(part: any): string {
  if (typeof part.content === "string") return part.content;
  if (!Array.isArray(part.content)) return "";
  let text = "";
  for (const block of part.content) {
    if (block?.type === "text" && typeof block.text === "string")
      text += (text ? "\n" : "") + block.text;
  }
  return text;
}

export function projectClaudeRecord(
  row: any,
  id: string,
  text: string,
  input: { requestId: string; text: string } | undefined,
  includeActivity: boolean,
): ClaudeHistoryRecord | undefined {
  if (row.isMeta && !input) return;
  const content = Array.isArray(row.message?.content) ? row.message.content : [];
  const images = content.filter((part: any) => part?.type === "image").length;
  const visible = ["user", "assistant"].includes(row.type) && (!!text || (row.type === "user" && images > 0));
  const actualPrompt = row.type === "user" && visible && !row.isCompactSummary &&
    !content.some((part: any) => part?.type === "tool_result") &&
    !/^<local-command-(?:caveat|stdout|stderr)>/.test(text.trim());
  const record: ClaudeHistoryRecord = {
    id,
    parentId: typeof row.parentUuid === "string" ? row.parentUuid : undefined,
    userId: typeof row.user_message_uuid === "string" ? row.user_message_uuid : undefined,
    prompt: actualPrompt,
    items: [],
  };
  const tools = content.some((part: any) => part?.type === "tool_use");
  const completed = row.type === "assistant" && row.message?.stop_reason === "end_turn" &&
    !row.aborted && !row.isApiErrorMessage && !row.error && !tools;
  if (row.type === "assistant") {
    if (row.aborted) record.outcome = "interrupted";
    else if (row.isApiErrorMessage || row.error) record.outcome = "failed";
    else if (completed) record.outcome = "completed";
    else record.outcome = "unknown";
  } else if (row.type === "result" && record.userId) {
    // SDK result records are explicit. A duration/idle event is not completion.
    if (row.subtype === "success" && row.is_error === false && row.stop_reason === "end_turn") record.outcome = "completed";
    else if (row.is_error === true) record.outcome = "failed";
  }
  if (visible) record.items.push({
    id: input ? `harbor-ide-user:${input.requestId}` : id,
    kind: row.type,
    text: input?.text || text,
    imageCount: images,
    ...(row.type === "assistant" ? {
      phase: completed ? "final_answer" : tools || row.message?.stop_reason === "tool_use" ? "commentary" : undefined,
      turnStatus: record.outcome || "unknown",
    } : {}),
  });
  if (includeActivity) for (const [index, part] of content.entries()) {
    if (record.items.length >= 2048) { record.activityOmitted = true; break; }
    if (part?.type === "tool_use") record.items.push({
      id: `${id}:tool:${index}`, kind: part.name === "Bash" ? "command" : "tool",
      text: bounded(part.name, 200) || "도구 실행", detail: toolDescription(part), status: "started",
    });
    else if (part?.type === "tool_result") record.items.push({
      id: `${id}:result:${index}`, kind: "tool", text: "도구 결과",
      detail: toolResult(part), status: part.is_error ? "failed" : "completed",
    });
  }
  return record.items.length || record.outcome ? record : undefined;
}

export function assembleClaudeHistory(records: ClaudeHistoryRecord[], includeActivity: boolean): {
  items: MessageItem[]; timeline?: MessageItem[]; activityOmitted: boolean;
} {
  const timeline: MessageItem[] = [], items: MessageItem[] = [];
  const byRecord = new Map<string, string>(), outcomes = new Map<string, MessageItem["turnStatus"]>();
  let currentTurn: string | undefined, activityOmitted = false;
  for (const record of records) {
    activityOmitted ||= !!record.activityOmitted;
    const explicitTurn = record.userId ? `claude-user:${record.userId}` : undefined;
    if (record.prompt) currentTurn = `claude-user:${record.id}`;
    else if (explicitTurn) currentTurn = explicitTurn;
    const turnId = explicitTurn || (record.parentId && byRecord.get(record.parentId)) || currentTurn;
    if (turnId) {
      byRecord.set(record.id, turnId);
      if (record.outcome) outcomes.set(turnId, record.outcome);
    }
    for (const source of record.items) {
      const item = { ...source, ...(turnId ? { turnId } : {}) };
      if (item.kind === "user" || item.kind === "assistant") items.push(item);
      if (includeActivity) timeline.push(item);
    }
  }
  // Only a native completion record can make an entire known turn collapsible.
  for (const item of includeActivity ? timeline : items) {
    if (item.turnId) item.turnStatus = outcomes.get(item.turnId) || "unknown";
    if (item.kind === "assistant" && item.turnStatus === "completed" && !item.phase)
      item.phase = "commentary";
  }
  // A result can prove completion of a text block whose streamed stop_reason was null.
  for (const [turnId, outcome] of outcomes) {
    if (outcome !== "completed") continue;
    const last = [...items].reverse().find(item => item.turnId === turnId && item.kind === "assistant");
    if (last && last.phase !== "final_answer") last.phase = "final_answer";
  }
  return { items, ...(includeActivity ? { timeline } : {}), activityOmitted };
}
