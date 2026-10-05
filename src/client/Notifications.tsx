import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { api } from "./api";
import type { TerminalNotice } from "../shared/notices";

export interface WorkspaceNotice {
  id: string;
  target: "terminal" | "session";
  targetId: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
}
type Input = Omit<WorkspaceNotice, "id" | "at" | "read"> & { id?: string };
const NoticeContext = createContext<{
  notices: WorkspaceNotice[];
  push: (notice: Input) => void;
  read: (targetId?: string) => void;
  sync: (notices: TerminalNotice[]) => void;
  isServerNoticeEnabled: () => boolean;
}>({
  notices: [],
  push: () => {},
  read: () => {},
  sync: () => {},
  isServerNoticeEnabled: () => false,
});
export const useNotifications = () => useContext(NoticeContext);
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
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
    if (serverNotices.current)
      void api("/notices/read", targetId ? { terminalId: targetId } : {}).catch(
        () => {},
      );
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
  useEffect(() => {
    const count = notices.filter((n) => !n.read).length;
    document.title = `${count ? `(${count}) ` : ""}Harbor`;
  }, [notices]);
  return (
    <NoticeContext.Provider
      value={{ notices, push, read, sync, isServerNoticeEnabled }}
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
