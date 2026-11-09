import type { IdeFile, IdeSelection } from "./types";

export const documentKey = (file: Pick<IdeFile, "hostId" | "path">) =>
  JSON.stringify([file.hostId, file.path]);
export const fileName = (path: string) =>
  path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
export const dirtyFile = (file: IdeFile, draft: string) =>
  file.content !== draft;
export function savedFile(file: IdeFile, saved: IdeFile): IdeFile {
  if (
    documentKey(file) !== documentKey(saved) ||
    file.terminalId !== saved.terminalId
  )
    throw new Error(
      "저장 응답이 원래 파일과 다릅니다. 편집 내용은 유지됩니다.",
    );
  return saved;
}
export function selectionText(selection: IdeSelection): string {
  const text = `파일: ${selection.path}\n범위: ${selection.startLine}:${selection.startColumn}–${selection.endLine}:${selection.endColumn}${selection.unsaved ? " (아직 저장하지 않은 편집 내용)" : ""}\n\n${selection.text}`;
  if (!selection.text.trim()) throw new Error("코드를 먼저 선택해주세요.");
  if (text.length > 16_000)
    throw new Error("인용은 16,000자까지 가능합니다. 선택 범위를 줄여주세요.");
  return text;
}
