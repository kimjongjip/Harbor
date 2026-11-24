/** One draft per open tab. Session list metadata contains no message contents. */
const ageLimit = 7 * 86400000;
function key(scope: string, tab: string) {
  return "harbor.chat.tab-draft.v1." + JSON.stringify([scope, tab]);
}
export function readManagedTabDraft(
  scope: string,
  tab: string,
): string | undefined {
  try {
    const storageKey = key(scope, tab),
      raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (
      typeof saved.text === "string" &&
      Number.isFinite(saved.time) &&
      saved.time > Date.now() - ageLimit
    )
      return saved.text;
    localStorage.removeItem(storageKey);
  } catch {
    /* storage can be unavailable */
  }
}
export function writeManagedTabDraft(scope: string, tab: string, text: string) {
  try {
    const storageKey = key(scope, tab);
    if (text)
      localStorage.setItem(
        storageKey,
        JSON.stringify({ text, time: Date.now() }),
      );
    else localStorage.removeItem(storageKey);
    return true;
  } catch {
    return false; /* Keep the in-memory draft when local storage is unavailable or full. */
  }
}
