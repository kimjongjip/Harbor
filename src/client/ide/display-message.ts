import type { MessageItem } from "../../shared/types";
import type { IdeSelection } from "./types";

export function displayMessage(item: MessageItem): {
  text: string;
  selection?: Pick<
    IdeSelection,
    "path" | "startLine" | "endLine" | "unsaved" | "text"
  >;
} {
  if (item.kind !== "user") return { text: item.text };
  const match = item.text.match(
    /\n\n<editor_selection>\n([\s\S]+)\n<\/editor_selection>$/,
  );
  if (!match) return { text: item.text };
  try {
    const selection = JSON.parse(match[1]);
    if (
      typeof selection.path !== "string" ||
      typeof selection.text !== "string" ||
      !Number.isInteger(selection.startLine) ||
      !Number.isInteger(selection.endLine)
    )
      return { text: item.text };
    return { text: item.text.slice(0, match.index), selection };
  } catch {
    return { text: item.text };
  }
}
