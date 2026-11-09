import type { MailboxMessage } from "../shared/mailbox.js";
import type { ResearchLab } from "../shared/research.js";
import { CLAUDE_PEER_CHANNEL_INSTRUCTIONS } from "./claude-peer-channel.js";

/** A hook is a native turn boundary, not an idle push channel or model receipt. */
export function claudeHookMessageActive(
  message: MailboxMessage,
  lab?: ResearchLab,
): boolean {
  const labId = message.research?.labId || message.labId;
  if (!labId) return true;
  if (!lab || lab.id !== labId) return false;
  if (
    !lab.participants.some(
      (p) =>
        p.kind === "claude" &&
        p.terminalId === message.recipient.terminalId &&
        p.sessionId === message.recipient.sessionId,
    )
  )
    return false;
  if (message.research?.assignmentId.startsWith("preparation:"))
    return (
      lab.status === "preparing" && message.research.revision === lab.revision
    );
  if (lab.status !== "running") return false;
  if (message.research) {
    return (
      message.research.revision === lab.revision &&
      lab.assignments.some(
        (j) =>
          j.id === message.research!.assignmentId &&
          lab.participants[j.participant]?.terminalId ===
            message.recipient.terminalId &&
          j.revision === lab.revision &&
          j.phase === lab.phase &&
          j.cycle === lab.cycle &&
          !j.report,
      )
    );
  }
  const revision = message.labRevision ?? message.questionSource?.revision;
  return revision === undefined || revision === lab.revision;
}

export function claudeHookBatch(messages: MailboxMessage[]) {
  const envelopes: object[] = [];
  const selected: MailboxMessage[] = [];
  for (const m of messages) {
    const envelope: Record<string, unknown> = {
      messageId: m.id,
      threadId: m.threadId,
      from: m.sender,
      text: m.text,
      ...(m.replyToId ? { replyToId: m.replyToId } : {}),
      ...(m.purpose ? { purpose: m.purpose } : {}),
      ...(m.research ? { research: m.research } : {}),
      ...(m.labId ? { labId: m.labId } : {}),
    };
    // Escaped text/path data must not strand an otherwise valid first message.
    // Its stored bytes remain intact; the model fetches the full MCP inbox.
    if (JSON.stringify(envelope).length > 32_000) {
      envelope.text = m.text.slice(0, 8_000);
      envelope.previewTruncated = true;
    }
    if (JSON.stringify([...envelopes, envelope]).length > 32_000) break;
    envelopes.push(envelope);
    selected.push(m);
    if (selected.length === 4) break;
  }
  return {
    messages: selected,
    context: selected.length
      ? `${CLAUDE_PEER_CHANNEL_INSTRUCTIONS}\nHarbor messages for this native conversation follow as JSON data. Fetch them with harbor_inbox to confirm actual receipt before reporting or replying. Do not invent a user's approval.\n${JSON.stringify(envelopes)}`
      : "",
  };
}
