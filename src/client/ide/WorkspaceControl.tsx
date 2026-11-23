import { useEffect, useState } from "react";
import type { IdeChatConversation } from "../../shared/ide-chat";
import {
  workspaceClientId,
  workspaceLeaseKey,
  workspaceLeases,
  workspaceRequest,
} from "./workspace-request";

export function WorkspaceControl({
  chat,
  mobile,
}: {
  chat: IdeChatConversation;
  mobile: boolean;
}) {
  const terminal = chat.live!.terminalId,
    key = workspaceLeaseKey(chat.hostId, terminal);
  const [owns, setOwns] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false);
  async function change(
    action: "claim" | "renew" | "release",
    token?: string,
    takeover?: boolean,
  ) {
    const res = await workspaceRequest(chat.hostId, mobile)(
      "/conversations/" + encodeURIComponent(chat.id) + "/control",
      {
        method: "POST",
        body: JSON.stringify({
          runtimeId: chat.runtimeId,
          clientId: workspaceClientId,
          action,
          token,
          takeover,
        }),
      },
    );
    const value = await res.json();
    if (!res.ok)
      throw Object.assign(Error(value.error || "제어권을 확인하세요."), {
        status: res.status,
      });
    return value as { token?: string };
  }
  useEffect(() => {
    if (!owns) return;
    let active = true;
    const timer = setInterval(() => {
      const token = workspaceLeases.get(key);
      if (!token) return;
      void change("renew", token).catch((e) => {
        if (active && token === workspaceLeases.get(key)) {
          workspaceLeases.delete(key);
          setOwns(false);
          setError(e.message);
        }
      });
    }, 12000);
    return () => {
      active = false;
      clearInterval(timer);
      const token = workspaceLeases.get(key);
      workspaceLeases.delete(key);
      if (token) void change("release", token).catch(() => {});
    };
  }, [key, owns, chat.id, chat.runtimeId]);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="button secondary small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            if (owns) {
              await change("release", workspaceLeases.get(key));
              workspaceLeases.delete(key);
              setOwns(false);
            } else {
              const { token } = await change("claim", undefined, conflict);
              if (!token) throw Error("제어권을 확인하세요.");
              workspaceLeases.set(key, token);
              setConflict(false);
              setOwns(true);
            }
          } catch (e) {
            setError((e as Error).message);
            setConflict((e as { status?: number }).status === 409);
          } finally {
            setBusy(false);
          }
        }}
      >
        {owns
          ? "제어 해제"
          : conflict
            ? "이 창으로 제어 전환"
            : "이 창에서 제어"}
      </button>
      {error && <span role="status">{error}</span>}
    </div>
  );
}
