import { useEffect, useState } from "react";
import { api } from "./api";
import { Modal } from "./Dialogs";
import { Markdown } from "./RichMarkdown";
import { useNotifications } from "./Notifications";
import {
  REPORT_DIRECTORY,
  reportFeedSchema,
  reportFile,
  reportSchema,
  type Report,
} from "../shared/report-notices";

async function reportJson(hostId: string, path: string, signal: AbortSignal) {
  const preview = await api<{
    kind: string;
    text?: string;
    truncated?: boolean;
  }>(
    `/hosts/${encodeURIComponent(hostId)}/files/preview?${new URLSearchParams({ path })}`,
    undefined,
    "GET",
    signal,
  );
  if (
    preview.kind !== "text" ||
    preview.truncated ||
    typeof preview.text !== "string"
  )
    throw new Error("조사 알림 파일을 온전히 읽지 못했습니다.");
  return JSON.parse(preview.text);
}

export function ReportNotificationsSync({ hostId }: { hostId?: string }) {
  const { syncReports } = useNotifications();
  useEffect(() => {
    if (!hostId) return;
    const abort = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || abort.signal.aborted) return;
      busy = true;
      try {
        const feed = reportFeedSchema.parse(
          await reportJson(
            hostId,
            `${REPORT_DIRECTORY}/index.json`,
            AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
          ),
        );
        if (!abort.signal.aborted) syncReports(hostId, feed.reports);
      } catch {
        // Not configured, temporarily unavailable, or incomplete: preserve the last good list.
      } finally {
        busy = false;
      }
    };
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    void refresh();
    const timer = window.setInterval(visible, 60000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("harbor-reports-refresh", visible);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("harbor-reports-refresh", visible);
    };
  }, [hostId, syncReports]);
  return null;
}

export function ReportNoticeDialog({
  target,
  onClose,
}: {
  target: { hostId: string; id: string };
  onClose: () => void;
}) {
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setReport(undefined);
    setError("");
    void reportJson(
      target.hostId,
      reportFile(target.id),
      AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    )
      .then((value) => {
        const next = reportSchema.parse(value);
        if (next.id !== target.id)
          throw new Error("보고서 식별자가 일치하지 않습니다.");
        if (!abort.signal.aborted) setReport(next);
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "보고서를 읽지 못했습니다.",
          );
      });
    return () => abort.abort();
  }, [target.hostId, target.id]);
  return (
    <Modal
      title={report?.title || "조사 보고서"}
      subtitle={
        report ? new Date(report.at).toLocaleDateString("ko-KR") : undefined
      }
      onClose={onClose}
      wide
      isolateEvents
    >
      <div className="report-notice-content">
        {error ? (
          <p role="alert">{error}</p>
        ) : report ? (
          <Markdown text={report.markdown} />
        ) : (
          <p role="status">보고서를 불러오는 중…</p>
        )}
      </div>
    </Modal>
  );
}
