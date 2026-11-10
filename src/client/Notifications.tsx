import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { api } from "./api";
import type { TerminalNotice } from "../shared/notices";
import type { ReportSummary } from "../shared/report-notices";

export interface WorkspaceNotice {
  id: string;
  target: "terminal" | "session" | "report";
  targetId: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
  report?: { hostId: string; id: string };
}
type Input = Omit<WorkspaceNotice, "id" | "at" | "read"> & { id?: string };
const NoticeContext = createContext<{
  notices: WorkspaceNotice[];
  push: (notice: Input) => void;
  read: (targetId?: string) => void;
  sync: (notices: TerminalNotice[]) => void;
  syncReports: (hostId: string, reports: ReportSummary[]) => void;
  isServerNoticeEnabled: () => boolean;
}>({
  notices: [],
  push: () => {},
  read: () => {},
  sync: () => {},
  syncReports: () => {},
  isServerNoticeEnabled: () => false,
});
export const useNotifications = () => useContext(NoticeContext);
const reportReadKey = "harbor.reportNotices.read.v1";
function loadReportReads(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(reportReadKey) || "{}");
    return value && !Array.isArray(value) && typeof value === "object"
      ? (Object.fromEntries(
          Object.entries(value).filter(([, at]) => typeof at === "number"),
        ) as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
  const [reports, setReports] = useState<WorkspaceNotice[]>([]);
  const [reportReads, setReportReads] = useState(loadReportReads);
  const reportsRef = useRef(reports);
  reportsRef.current = reports;
  const syncReports = useCallback((hostId: string, items: ReportSummary[]) => {
    const next = items.map((item) => ({
      id: `report-${hostId}-${item.id}`,
      target: "report" as const,
      targetId: `report-${hostId}-${item.id}`,
      title: item.title,
      body: item.summary,
      at: item.at,
      read: false,
      report: { hostId, id: item.id },
    }));
    setReports((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === reportReadKey) setReportReads(loadReportReads());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const serverNotices = useRef(false);
  const isServerNoticeEnabled = useCallback(() => serverNotices.current, []);
  const push = useCallback((notice: Input) => {
    const at = Date.now();
    setNotices((prev) => {
      if (
        prev.some((n) =>
          notice.id
            ? n.id === notice.id
            : n.targetId === notice.targetId &&
              n.body === notice.body &&
              at - n.at < 5000,
        )
      )
        return prev;
      return [
        { ...notice, id: notice.id || crypto.randomUUID(), at, read: false },
        ...prev,
      ].slice(0, 100);
    });
  }, []);
  const read = useCallback((targetId?: string) => {
    if (serverNotices.current && (!targetId || !targetId.startsWith("report-")))
      void api("/notices/read", targetId ? { terminalId: targetId } : {}).catch(
        () => {},
      );
    setReportReads((previous) => {
      const next = { ...previous, ...loadReportReads() };
      for (const report of reportsRef.current)
        if (!targetId || report.targetId === targetId)
          next[report.id] = report.at;
      const bounded = Object.fromEntries(
        Object.entries(next)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 1000),
      );
      if (JSON.stringify(bounded) === JSON.stringify(previous)) return previous;
      try {
        localStorage.setItem(reportReadKey, JSON.stringify(bounded));
      } catch {}
      return bounded;
    });
    setNotices((prev) =>
      !prev.some((n) => !n.read && (!targetId || n.targetId === targetId))
        ? prev
        : prev.map((n) =>
            !targetId || n.targetId === targetId ? { ...n, read: true } : n,
          ),
    );
  }, []);
  const sync = useCallback((items: TerminalNotice[]) => {
    serverNotices.current = true;
    setNotices((prev) =>
      [
        ...items.map((item) => ({
          id: `server-${item.id}`,
          target: "terminal" as const,
          targetId: item.terminalId,
          title: item.title,
          body: item.body,
          at: item.at,
          read: item.read,
        })),
        ...prev.filter((item) => !item.id.startsWith("server-")),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, 100),
    );
  }, []);
  const combined = useMemo(
    () =>
      [
        ...notices,
        ...reports.map((report) => ({
          ...report,
          read: reportReads[report.id] === report.at,
        })),
      ].sort((a, b) => b.at - a.at),
    [notices, reports, reportReads],
  );
  useEffect(() => {
    const count = combined.filter((n) => !n.read).length;
    document.title = `${count ? `(${count}) ` : ""}Harbor`;
  }, [combined]);
  return (
    <NoticeContext.Provider
      value={{
        notices: combined,
        push,
        read,
        sync,
        syncReports,
        isServerNoticeEnabled,
      }}
    >
      {children}
    </NoticeContext.Provider>
  );
}
export function NotificationCenter({
  onOpen,
}: {
  onOpen: (notice: WorkspaceNotice) => void;
}) {
  const { notices, read } = useNotifications();
  const [open, setOpen] = useState(false);
  const unread = notices.filter((n) => !n.read).length;
  return (
    <div className="notification-center">
      <button
        className={`notification-button ${unread ? "has-unread" : ""}`}
        aria-label={`알림 ${unread}개`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bell size={17} />
        {unread > 0 && <b>{unread}</b>}
      </button>
      {open && (
        <>
          <button
            className="notification-scrim"
            aria-label="알림 닫기"
            onClick={() => setOpen(false)}
          />
          <section className="notification-panel" aria-label="알림 목록">
            <header>
              <b>알림</b>
              <button
                className="icon-button"
                title="모두 읽음"
                aria-label="알림 모두 읽음"
                onClick={() => read()}
              >
                <CheckCheck size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="알림 패널 닫기"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            {!notices.length && (
              <div className="notification-empty">
                <Bell size={26} />
                <p>아직 알림이 없습니다</p>
                <small>
                  Codex가 보내는 터미널 알림과 세션 메시지를 여기에 모읍니다.
                </small>
              </div>
            )}
            <div className="notification-list">
              {notices.map((notice) => (
                <button
                  key={notice.id}
                  className={`notification-item ${notice.read ? "" : "unread"}`}
                  onClick={() => {
                    read(notice.targetId);
                    onOpen(notice);
                    setOpen(false);
                  }}
                >
                  <span className="notification-item-title">
                    {notice.title}
                    <time>
                      {new Date(notice.at).toLocaleTimeString("ko-KR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </span>
                  <p>{notice.body}</p>
                  <small>세션으로 이동 →</small>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
