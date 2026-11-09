/** Non-typed records that native CLIs store as "user" messages. */
export type UserMessageOrigin =
  | "command"
  | "command-output"
  | "notification"
  | "interrupt"
  | "channel"
  | "system";

export interface ClassifiedUserMessage {
  /** Undefined means the person typed this prompt. */
  origin?: UserMessageOrigin;
  /** Display text; the stored record is never changed. */
  text: string;
  detail?: string;
  /** The native CLI answers this record as a new turn. */
  startsTurn: boolean;
  /** Pure model-facing boilerplate (caveats, reminders) with nothing to show. */
  hidden?: boolean;
}

// Claude 2.1.295+ labels typed prompts; other kinds are generated input.
const typedOrigins = new Set([
  "human",
  "voice-call",
  "suggestion",
  "composer",
  "person",
]);
const generatedOrigins: Record<string, UserMessageOrigin> = {
  "task-notification": "notification",
  channel: "channel",
  peer: "channel",
  "auto-continuation": "system",
  plugin: "system",
  coordinator: "system",
  "observer-activity": "system",
};

const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const inner = (text: string, name: string) =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(text)?.[1];
const clean = (value: string | undefined) =>
  (value || "").replace(ansi, "").trim();
const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

// Exact first lines of Harbor's own Codex peer/research deliveries.
const harborCodexPrefixes = [
  "The user asked you to prepare a research proposal from this native conversation.",
  "This is an assignment from a user-started Harbor research lab",
  "Your research peer replied.",
  "Your research peer asks you to resolve a research uncertainty together.",
  "A Harbor peer session replied to your earlier message.",
  "A Harbor peer session has a question about your current work.",
];

function harborEnvelope(text: string): ClassifiedUserMessage | undefined {
  if (!harborCodexPrefixes.some((prefix) => text.startsWith(prefix))) return;
  const newline = text.indexOf("\n{");
  if (newline < 0) return;
  try {
    const envelope = JSON.parse(text.slice(newline + 1));
    if (!envelope || typeof envelope.messageId !== "string") return;
    const sender =
      typeof envelope.from?.title === "string" ? envelope.from.title : "";
    return {
      origin: "channel",
      text:
        typeof envelope.text === "string" && envelope.text.trim()
          ? envelope.text.trim()
          : text.slice(0, newline),
      ...(sender ? { detail: sender } : {}),
      startsTurn: true,
    };
  } catch {
    return;
  }
}

/**
 * Classify a stored user record for display. Typed prompts keep their text;
 * slash commands, command output, background notices, interrupts and channel
 * deliveries are recognized only from their exact CLI/Harbor markers.
 */
export function classifyUserMessage(
  raw: string,
  originKind?: unknown,
): ClassifiedUserMessage {
  const text = raw.trim();
  if (typeof originKind === "string") {
    if (typedOrigins.has(originKind)) return { text: raw, startsTurn: true };
    const generated = generatedOrigins[originKind];
    if (generated && !/^<(?:task-notification|channel)[\s>]/.test(text))
      return {
        origin: generated,
        text: clean(text) || raw,
        startsTurn: true,
      };
  }
  if (/^<command-(?:name|message)>/.test(text)) {
    const name =
      clean(inner(text, "command-name")) ||
      `/${clean(inner(text, "command-message"))}`;
    const args = clean(inner(text, "command-args"));
    return {
      origin: "command",
      text: [name, args].filter(Boolean).join(" "),
      startsTurn: true,
    };
  }
  if (/^<local-command-caveat>/.test(text))
    return { origin: "system", text: "", startsTurn: false, hidden: true };
  if (/^<local-command-(?:stdout|stderr)>/.test(text))
    return {
      origin: "command-output",
      text: [
        clean(inner(text, "local-command-stdout")),
        clean(inner(text, "local-command-stderr")),
      ]
        .filter(Boolean)
        .join("\n"),
      startsTurn: false,
    };
  if (/^<bash-input>/.test(text))
    return {
      origin: "command",
      text: `! ${clean(inner(text, "bash-input"))}`,
      startsTurn: true,
    };
  if (/^<bash-(?:stdout|stderr)>/.test(text))
    return {
      origin: "command-output",
      text: [
        clean(inner(text, "bash-stdout")),
        clean(inner(text, "bash-stderr")),
      ]
        .filter(Boolean)
        .join("\n"),
      startsTurn: false,
    };
  if (/^<task-notification>/.test(text)) {
    const summary = clean(inner(text, "summary"));
    const status = clean(inner(text, "status"));
    return {
      origin: "notification",
      text: summary || (status ? `백그라운드 작업 ${status}` : "백그라운드 작업 알림"),
      ...(status && summary ? { detail: status } : {}),
      startsTurn: true,
    };
  }
  if (/^\[Request interrupted by user[^\]]*\]$/.test(text))
    return { origin: "interrupt", text, startsTurn: false };
  const channel = /^(<channel(?:\s[^>]*)?>)([\s\S]*)<\/channel>$/.exec(text);
  if (channel) {
    const sender =
      attribute(channel[1], "sender_name") || attribute(channel[1], "source");
    return {
      origin: "channel",
      text: clean(channel[2]),
      ...(sender ? { detail: sender } : {}),
      startsTurn: true,
    };
  }
  if (/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text))
    return { origin: "system", text: "", startsTurn: false, hidden: true };
  if (/^<user-prompt-submit-hook>/.test(text))
    return {
      origin: "system",
      text: clean(inner(text, "user-prompt-submit-hook")),
      startsTurn: false,
    };
  return harborEnvelope(text) || { text: raw, startsTurn: true };
}
