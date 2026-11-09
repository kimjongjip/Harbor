import type { MessageItem } from "../shared/types.js";
import { normalizeItem } from "./session.js";

const text = (value: unknown): string => typeof value === "string" ? value : "";
/** Only explicit public text blocks, never hidden reasoning/image/binary fields. */
const textBlocks = (value: unknown): string => typeof value === "string" ? value :
  Array.isArray(value) ? value.flatMap(block => block &&
    ["text", "inputText", "outputText"].includes(block.type) && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
const publicArguments = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const input = value as Record<string, unknown>;
  return ["command", "file_path", "path", "pattern", "query", "description", "target", "recipient", "message", "question", "prompt"]
    .flatMap(key => typeof input[key] === "string" ? [`${key}: ${input[key]}`] : []).join("\n");
};

/** History keeps exact saved public text; display-size limits belong to lazy previews. */
export function historyItem(raw: any, turnId?: string): MessageItem | null {
  const item = normalizeItem(raw, turnId);
  if (!item) return null;
  switch (raw.type) {
    case "userMessage": item.text = textBlocks(raw.content); break;
    case "agentMessage": case "plan": item.text = text(raw.text); break;
    case "commandExecution": item.text = text(raw.command); item.detail = text(raw.aggregatedOutput); break;
    case "fileChange":
      item.text = (raw.changes || []).map((change: any) => text(change.path)).join("\n");
      item.detail = (raw.changes || []).map((change: any) => `--- ${text(change.path)}\n${text(change.diff)}`).join("\n");
      break;
    case "mcpToolCall":
      item.text = [text(raw.server), text(raw.tool)].filter(Boolean).join(" / ") || "도구 실행";
      item.detail = [publicArguments(raw.arguments), textBlocks(raw.result?.content), text(raw.error?.message)].filter(Boolean).join("\n");
      break;
    case "dynamicToolCall":
      item.text = text(raw.tool) || "도구 실행";
      item.detail = [publicArguments(raw.arguments), textBlocks(raw.contentItems), textBlocks(raw.result?.content), text(raw.error?.message)].filter(Boolean).join("\n");
      break;
    case "collabAgentToolCall": {
      const tool = text(raw.tool) || "상호작용";
      const peers = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.filter((id: unknown) => typeof id === "string") : [];
      item.text = `Interacted · ${tool}${peers.length ? ` · ${peers.join(", ")}` : ""}`;
      const states = raw.agentsStates && typeof raw.agentsStates === "object" ?
        Object.entries(raw.agentsStates).flatMap(([id, state]: [string, any]) => {
          const message = text(state?.message);
          return message ? [`${id}: ${message}`] : [];
        }) : [];
      item.detail = [text(raw.prompt), ...states].filter(Boolean).join("\n");
      break;
    }
    case "webSearch": item.detail = text(raw.query) || text(raw.action?.query); break;
    case "exitedReviewMode": item.text = text(raw.review); break;
  }
  return item;
}
