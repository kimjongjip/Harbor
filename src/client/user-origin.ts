import type { MessageItem } from "../shared/types";
import {
  classifyUserMessage,
  type UserMessageOrigin,
} from "../shared/user-message-origin";

export interface UserMessageView {
  origin?: UserMessageOrigin;
  text: string;
  detail?: string;
  hidden?: boolean;
}

const views = new WeakMap<MessageItem, { text: string; view: UserMessageView }>();

/** Server-classified origin, or the same exact-marker check for items an
 * older backend still sends with raw CLI tags. Display only. */
export function userMessageView(item: MessageItem): UserMessageView {
  if (item.kind !== "user") return { text: item.text };
  if (item.origin)
    return { origin: item.origin, text: item.text, detail: item.detail };
  const cached = views.get(item);
  if (cached?.text === item.text) return cached.view;
  const result = classifyUserMessage(item.text);
  const view: UserMessageView = result.origin
    ? {
        origin: result.origin,
        text: result.text,
        detail: result.detail,
        hidden: result.hidden,
      }
    : { text: item.text };
  views.set(item, { text: item.text, view });
  return view;
}

const labels = {
  command: "명령",
  "command-output": "출력",
  notification: "알림",
  interrupt: "중단",
  channel: "메시지",
  system: "시스템",
} as const;
/** Who/what produced a non-typed record, for its header in place of "나". */
export function userOriginLabel(view: UserMessageView): string {
  if (!view.origin) return "나";
  return view.origin === "channel" && view.detail
    ? `메시지 · ${view.detail}`
    : labels[view.origin];
}

/** A prompt the person actually typed into the CLI. */
export const typedPrompt = (item: MessageItem) =>
  item.kind === "user" && !userMessageView(item).origin;
