import type { IdeSelection } from "./types";
import { selectionText } from "./state";

const receivers = new Map<string, (selection: IdeSelection) => Promise<void>>();
export function registerIdeAnnotation(
  id: string,
  receive: (selection: IdeSelection) => Promise<void>,
) {
  receivers.set(id, receive);
  return () => {
    if (receivers.get(id) === receive) receivers.delete(id);
  };
}
export async function quoteIdeSelection(
  selection: IdeSelection,
): Promise<void> {
  selectionText(selection);
  const receive = receivers.get(selection.terminalId);
  if (!receive)
    throw new Error("이 창에서 해당 터미널을 연 뒤 다시 인용해주세요.");
  await receive(selection);
}
