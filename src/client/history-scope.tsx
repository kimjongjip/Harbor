import type { HistoryThread } from "../shared/history";

export function absoluteHistoryFolder(cwd?: string) {
  return cwd && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(cwd) ? cwd : undefined;
}

export function HistoryScopeHeading({folder, scope, previous}: {
  folder?: string;
  scope?: HistoryThread["historyScope"];
  previous?: HistoryThread["historyScope"];
}) {
  if (!folder || !scope || previous === scope) return null;
  return (
    <h4 className="history-scope-heading" title={scope === "folder" ? folder : undefined}>
      {scope === "folder" ? "선택한 폴더" : "다른 폴더"}
    </h4>
  );
}
