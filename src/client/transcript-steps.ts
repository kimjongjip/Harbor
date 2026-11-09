import type { MessageItem } from "../shared/types";
import { userMessageView } from "./user-origin";

/** Display grouping only: the saved records and their order are unchanged. */
export type TranscriptEntry =
  | { kind: "message"; item: MessageItem }
  | { kind: "system"; item: MessageItem; outputs: MessageItem[] }
  | { kind: "commentary"; item: MessageItem }
  | { kind: "step"; key: string; call?: MessageItem; result?: MessageItem }
  | { kind: "item"; item: MessageItem };

const workKinds = new Set(["command", "tool", "change", "plan"]);
export const isWorkItem = (item: MessageItem) =>
  workKinds.has(item.kind) ||
  (item.kind === "assistant" && item.phase === "commentary");

/** A Claude tool invocation record (its output arrives as a separate result). */
const toolCall = (item: MessageItem) =>
  (item.kind === "command" || item.kind === "tool") &&
  item.status === "started" &&
  !!item.text;
const toolResult = (item: MessageItem) =>
  item.kind === "tool" &&
  item.status !== "started" &&
  (!!item.toolUseId || item.text === "도구 결과" || !!item.format);

export function transcriptEntries(items: MessageItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const byToolId = new Map<string, Extract<TranscriptEntry, { kind: "step" }>>();
  // Older servers omit tool ids; results then pair with calls in issue order.
  let unpaired: Extract<TranscriptEntry, { kind: "step" }>[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      const view = userMessageView(item);
      if (view.hidden) continue;
      const previous = entries.at(-1);
      if (view.origin === "command-output" && previous?.kind === "system") {
        previous.outputs.push(item);
        continue;
      }
      entries.push(
        view.origin
          ? { kind: "system", item, outputs: [] }
          : { kind: "message", item },
      );
      unpaired = [];
      continue;
    }
    if (item.kind === "assistant") {
      entries.push(
        item.phase === "commentary"
          ? { kind: "commentary", item }
          : { kind: "message", item },
      );
      continue;
    }
    if (toolCall(item)) {
      const step = {
        kind: "step" as const,
        key: `${item.kind}:${item.id}`,
        call: item,
      } satisfies Extract<TranscriptEntry, { kind: "step" }>;
      entries.push(step);
      if (item.toolUseId) byToolId.set(item.toolUseId, step);
      else unpaired.push(step);
      continue;
    }
    if (toolResult(item)) {
      const step = item.toolUseId
        ? byToolId.get(item.toolUseId)
        : unpaired.shift();
      if (step && !step.result) {
        step.result = item;
        continue;
      }
      entries.push({ kind: "step", key: `${item.kind}:${item.id}`, result: item });
      continue;
    }
    entries.push({ kind: "item", item });
  }
  return entries;
}

const argumentKeys = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "description",
  "target",
  "recipient",
  "message",
  "question",
  "prompt",
] as const;

/** Parse the server's public "key: value" argument lines (values may span lines). */
export function toolArguments(detail = ""): Record<string, string> {
  const result: Record<string, string> = {};
  let current: string | undefined;
  for (const line of detail.split("\n")) {
    const match = /^([a-z_]+): ([\s\S]*)$/.exec(line);
    if (
      match &&
      (argumentKeys as readonly string[]).includes(match[1]) &&
      !(match[1] in result)
    ) {
      current = match[1];
      result[current] = match[2];
    } else if (current) result[current] += `\n${line}`;
  }
  return result;
}

const displayNames: Record<string, string> = {
  Edit: "Update",
  MultiEdit: "Update",
  NotebookEdit: "Update",
  Grep: "Search",
  Glob: "Search",
  TodoWrite: "Update Todos",
};

/** CLI-like heading: `Update(src/file.ts)`, `Bash(npm test)`, `server - tool (MCP)`. */
export function stepTitle(call: MessageItem | undefined, cwd = "") {
  if (!call) return { name: "도구 결과", target: "", args: {} as Record<string, string> };
  const args = toolArguments(call.detail);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call.text);
  const name = mcp
    ? `${mcp[1]} - ${mcp[2]} (MCP)`
    : displayNames[call.text] || call.text;
  let target =
    args.command ??
    args.file_path ??
    (args.pattern !== undefined
      ? `${args.pattern}${args.path ? ` · ${args.path}` : ""}`
      : undefined) ??
    args.query ??
    args.path ??
    args.description ??
    args.recipient ??
    args.target ??
    args.question ??
    args.prompt ??
    args.message ??
    "";
  const base = cwd.replace(/[\\/]+$/, "");
  if (
    base &&
    (target.startsWith(`${base}/`) || target.startsWith(`${base}\\`))
  )
    target = target.slice(base.length + 1);
  return { name, target, args };
}

export interface DiffLine {
  kind: "hunk" | "add" | "remove" | "context" | "file";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Unified diff (Claude structuredPatch hunks or Codex file diffs) with line numbers. */
export function parseDiff(text: string): DiffLine[] | undefined {
  const lines = text.split("\n");
  if (!lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)))
    return;
  const result: DiffLine[] = [];
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      result.push({ kind: "hunk", text: line });
    } else if (/^(?:---|\+\+\+) /.test(line) && !inHunk) {
      result.push({ kind: "file", text: line.replace(/^(?:---|\+\+\+) /, "") });
    } else if (!inHunk) {
      if (line.trim()) result.push({ kind: "file", text: line });
    } else if (line.startsWith("+")) {
      result.push({ kind: "add", text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-")) {
      result.push({ kind: "remove", text: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith("\\")) {
      result.push({ kind: "context", text: line });
    } else {
      result.push({
        kind: "context",
        text: line.startsWith(" ") ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }
  return result;
}
