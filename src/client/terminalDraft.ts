export interface TerminalDraft {
  terminalId: string;
  sessionId: string;
  text: string;
}
const editors = new Map<string, (draft: TerminalDraft) => void>();

/** Only the mounted terminal can append through its native bracketed paste. */
export function registerTerminalDraft(
  terminalId: string,
  insert: (draft: TerminalDraft) => void,
) {
  editors.set(terminalId, insert);
  return () => {
    if (editors.get(terminalId) === insert) editors.delete(terminalId);
  };
}
export function insertTerminalDraft(draft: TerminalDraft) {
  if (
    !draft.sessionId ||
    !draft.text.trim() ||
    draft.text.length > 4000 ||
    /[\x00-\x1f\x7f]/.test(draft.text)
  )
    throw new Error("계획 요청문이나 원래 대화 정보가 올바르지 않습니다.");
  const editor = editors.get(draft.terminalId);
  if (!editor)
    throw new Error(
      "이 창에서 주 대화 입력칸을 찾지 못했습니다. 요청문을 복사하여 주 대화에 붙여넣으세요.",
    );
  editor(draft);
}
