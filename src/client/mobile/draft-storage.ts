interface SavedDraft {
  terminal: string;
  session?: string;
  text: string;
  time: number;
}
const prefix = "harbor.mobile.drafts.";
const ageLimit = 7 * 86400000;
function drafts(device: string): SavedDraft[] {
  try {
    const list: unknown = JSON.parse(
      localStorage.getItem(prefix + device) || "[]",
    );
    return Array.isArray(list)
      ? list.filter(
          (entry) =>
            entry &&
            typeof entry.text === "string" &&
            typeof entry.terminal === "string" &&
            entry.time > Date.now() - ageLimit,
        )
      : [];
  } catch {
    return [];
  }
}
export function readDraft(device: string, terminal: string, session?: string) {
  return (
    drafts(device).find(
      (entry) => entry.terminal === terminal && entry.session === session,
    )?.text || ""
  );
}
export function saveDraft(
  device: string,
  terminal: string,
  session: string | undefined,
  text: string,
) {
  if (!device || !terminal) return;
  const list = drafts(device).filter((entry) => entry.terminal !== terminal);
  if (text && text.length <= 64000)
    list.unshift({ terminal, session, text, time: Date.now() });
  try {
    if (list.length)
      localStorage.setItem(prefix + device, JSON.stringify(list.slice(0, 12)));
    else clearDrafts(device);
  } catch {}
}
export function clearDrafts(device: string) {
  try {
    localStorage.removeItem(prefix + device);
  } catch {}
}
