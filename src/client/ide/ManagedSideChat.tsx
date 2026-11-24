import { useEffect, useRef, useState } from "react";
import type {
  IdeChatConversation,
  IdeChatReceipt,
} from "../../shared/ide-chat";
import { providerName } from "../../shared/agent-provider";
import { ApprovalCard } from "./ChatApproval";
import { TerminalUsageBar } from "../TerminalUsageBar";
import { Markdown } from "../RichMarkdown";
import { typedPrompt } from "../user-origin";
import {
  readManagedTabDraft,
  writeManagedTabDraft,
} from "./managed-tab-drafts";
import { displayMessage } from "./display-message";
import type { IdeChatRequest } from "./IdeChatPanel";

export interface SideChatState {
  open: boolean;
  storageScope?: string;
  recover?: { id: string; nativeId: string; provider: "claude" | "codex" };
  provider: "claude" | "codex";
  draft: string;
  quote?: string;
  started: boolean;
  createId: string;
  child?: IdeChatConversation;
  attempt?: { id: string; text: string };
  sent: Map<string, string>;
  listeners: Set<() => void>;
  busy: boolean;
  stopping?: boolean;
  readError?: string;
  error?: string;
}
export function newSideChat(
  provider: IdeChatConversation["provider"],
): SideChatState {
  return {
    open: false,
    provider: provider === "claude" ? "claude" : "codex",
    draft: "",
    started: false,
    createId: crypto.randomUUID(),
    sent: new Map(),
    listeners: new Set(),
    busy: false,
  };
}
export function sideStorageKey(
  windowScope: string,
  area: string,
  provider: string,
  nativeId: string,
) {
  return JSON.stringify(["side", windowScope, area, provider, nativeId]);
}
function restore(state: SideChatState, scope: string) {
  if (state.storageScope === scope) return;
  state.storageScope = scope;
  state.draft = readManagedTabDraft(scope, "side") ?? state.draft;
  try {
    const raw = JSON.parse(
      localStorage.getItem("harbor.side.v1." + scope) || "null",
    );
    if (
      raw &&
      typeof raw.id === "string" &&
      /^[\w-]{1,160}$/.test(raw.id) &&
      typeof raw.nativeId === "string" &&
      /^[\w-]{1,160}$/.test(raw.nativeId) &&
      (raw.provider === "codex" || raw.provider === "claude")
    ) {
      state.recover = raw;
      state.provider = raw.provider;
      state.started = true;
    }
  } catch {
    /* Continue with the in-memory conversation. */
  }
}
export function sideContext(parent: IdeChatConversation, selection: string) {
  if (selection.trim()) return selection.trim().slice(0, 16000);
  const messages = parent.items.filter(
    (item) =>
      typedPrompt(item) ||
      (item.kind === "assistant" &&
        item.status !== "inProgress" &&
        item.turnStatus !== "inProgress"),
  );
  return [...new Set([messages[0], ...messages.slice(-6)])]
    .filter(Boolean)
    .map(
      (m) =>
        (m.kind === "user" ? "나" : providerName(parent.provider)) +
        " · " +
        displayMessage(m).text.slice(0, 2000),
    )
    .join("\n\n")
    .slice(0, 16000);
}

async function sideRequest<T>(
  request: IdeChatRequest,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await request(path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: signal || AbortSignal.timeout(45000),
  });
  const value = await res.json();
  if (!res.ok)
    throw Object.assign(
      new Error(value?.error || "옆 대화를 연결할 수 없습니다."),
      { status: res.status },
    );
  return value;
}
function validChild(
  parent: IdeChatConversation,
  state: SideChatState,
  v: IdeChatConversation,
) {
  if (
    v.hostId !== parent.hostId ||
    v.provider !== state.provider ||
    v.id === parent.id ||
    v.nativeId === parent.nativeId ||
    !v.reviewOnly ||
    v.live
  )
    throw Object.assign(
      Error("이 응답을 독립된 읽기 전용 대화로 확인할 수 없습니다."),
      { code: "STALE_SIDE_BINDING" },
    );
  const prior = state.child;
  if (
    prior &&
    (v.id !== prior.id ||
      v.nativeId !== prior.nativeId ||
      v.runtimeId !== prior.runtimeId)
  )
    throw Object.assign(Error("옆 대화 연결이 변경되었습니다."), {
      code: "STALE_SIDE_BINDING",
    });
  if (!prior || v.revision >= prior.revision) state.child = v;
}

function SidePane({
  parent,
  state,
  request,
  selection,
  append,
  active,
}: {
  parent: IdeChatConversation;
  state: SideChatState;
  request: IdeChatRequest;
  selection: () => string;
  append: (text: string) => void;
  active: boolean;
}) {
  const [, rerender] = useState(0),
    log = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const repaint = () => state.listeners.forEach((changed) => changed());
  useEffect(() => {
    const changed = () => rerender((n) => n + 1);
    state.listeners.add(changed);
    return () => {
      state.listeners.delete(changed);
    };
  }, [state]);
  const child = state.child;
  useEffect(() => {
    if (!active || !state.recover || child) return;
    const saved = state.recover,
      controller = new AbortController();
    void sideRequest<IdeChatConversation>(
      request,
      "/conversations/" + encodeURIComponent(saved.id),
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    )
      .then((c) => {
        if (controller.signal.aborted) return;
        if (c.id !== saved.id || c.nativeId !== saved.nativeId)
          throw Error("이전 옆 대화의 ID를 확인할 수 없습니다.");
        validChild(parent, state, c);
        state.recover = undefined;
        state.error = undefined;
        state.readError = undefined;
        repaint();
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          state.error =
            "이전 옆 대화에 연결할 수 없습니다. 대화 기록에서 원문을 확인할 수 있습니다.";
          repaint();
        }
      });
    return () => controller.abort();
  }, [active, request, state, child?.id, parent.id, state.recover?.id]);
  useEffect(() => {
    if (!active || !child) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async () => {
      if (!disposed && document.visibilityState !== "hidden") {
        try {
          const v = await sideRequest<IdeChatConversation>(
            request,
            "/conversations/" + encodeURIComponent(child.id),
            undefined,
            AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
          );
          if (!disposed) {
            validChild(parent, state, v);
            state.readError = undefined;
            repaint();
          }
        } catch (e) {
          if (!disposed) {
            if (
              (e as { status?: number }).status === 404 ||
              (e as { code?: string }).code === "STALE_SIDE_BINDING"
            ) {
              state.recover = {
                id: child.id,
                nativeId: child.nativeId,
                provider: state.provider,
              };
              state.child = undefined;
            }
            state.readError = (e as Error).message;
            repaint();
          }
        }
      }
      if (
        !disposed &&
        (state.busy ||
          state.attempt ||
          state.child?.status === "running" ||
          state.child?.status === "waiting")
      )
        timer = setTimeout(
          read,
          state.child?.status === "running" ? 650 : 3500,
        );
    };
    void read();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, request, state, child?.id, child?.status, state.busy, parent.id]);
  useEffect(() => {
    const node = log.current;
    const selection = node?.ownerDocument.getSelection();
    if (
      node &&
      following.current &&
      !(
        selection &&
        !selection.isCollapsed &&
        node.contains(selection.anchorNode)
      )
    )
      node.scrollTop = node.scrollHeight;
  }, [child?.revision]);
  const running = child?.status === "running" || child?.status === "waiting";
  const send = async () => {
    if (
      !active ||
      state.recover ||
      state.busy ||
      running ||
      !state.draft.trim()
    )
      return;
    const draft = state.draft,
      quote = state.quote;
    const text = quote
      ? draft + "\n\n[원래 대화에서 인용 · " + parent.nativeId + "]\n" + quote
      : draft;
    const attempt =
      state.attempt?.text === text
        ? state.attempt
        : { id: crypto.randomUUID(), text };
    state.attempt = attempt;
    state.busy = true;
    state.error = undefined;
    following.current = true;
    repaint();
    try {
      if (!state.child) {
        const c = await sideRequest<IdeChatConversation>(
          request,
          "/conversations",
          {
            hostId: parent.hostId,
            provider: state.provider,
            ...(parent.cwd ? { cwd: parent.cwd } : {}),
            reviewOnly: true,
            requestId: state.createId,
            ...(parent.provider === state.provider && parent.effort
              ? { effort: parent.effort }
              : {}),
            ...(parent.provider === state.provider &&
            parent.model &&
            parent.model !== "default"
              ? { model: parent.model }
              : {}),
          },
        );
        validChild(parent, state, c);
        if (state.storageScope)
          try {
            localStorage.setItem(
              "harbor.side.v1." + state.storageScope,
              JSON.stringify({
                id: c.id,
                nativeId: c.nativeId,
                provider: c.provider,
              }),
            );
          } catch {}
        repaint();
      }
      const c = state.child!,
        path = "/conversations/" + encodeURIComponent(c.id);
      state.sent.set(text, draft);
      const result = await sideRequest<IdeChatReceipt>(
        request,
        path + "/messages",
        { runtimeId: c.runtimeId, requestId: attempt.id, text },
      );
      if (result.status === "uncertain") {
        state.error = "전송 여부를 확인하고 있습니다.";
        return;
      }
      if (state.draft === draft) {
        state.draft = "";
        if (state.storageScope)
          writeManagedTabDraft(state.storageScope, "side", "");
      }
      if (state.quote === quote) state.quote = undefined;
      state.attempt = undefined;
      if (!state.listeners.size) return;
      validChild(
        parent,
        state,
        await sideRequest<IdeChatConversation>(request, path),
      );
    } catch (e) {
      state.error = (e as Error).message;
    } finally {
      state.busy = false;
      repaint();
    }
  };
  async function control(path: string, body: Record<string, unknown>) {
    const c = state.child;
    if (!active || !c) throw Error("옆 대화의 연결을 확인하세요.");
    const base = "/conversations/" + encodeURIComponent(c.id);
    await sideRequest(request, base + path, {
      runtimeId: c.runtimeId,
      ...body,
    });
    validChild(
      parent,
      state,
      await sideRequest<IdeChatConversation>(request, base),
    );
    state.readError = undefined;
    repaint();
  }
  const answer = child?.items
    .filter(
      (i) =>
        i.kind === "assistant" && i.text.trim() && i.phase !== "commentary",
    )
    .at(-1);
  return (
    <section className="managed-side-pane" role="region" aria-label="옆 대화">
      <header>
        <label>
          옆 대화 AI{" "}
          <select
            aria-label="옆 대화 AI"
            value={state.provider}
            disabled={!!child || !!state.recover || state.busy}
            onChange={(e) => {
              state.provider = e.target.value as SideChatState["provider"];
              state.createId = crypto.randomUUID();
              repaint();
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <span>읽기 전용</span>
      </header>
      <div
        className="managed-side-log"
        ref={log}
        onScroll={(e) => {
          const n = e.currentTarget;
          following.current =
            n.scrollHeight - n.scrollTop - n.clientHeight < 36;
        }}
      >
        {child?.items
          .filter(
            (i) =>
              typedPrompt(i) || i.kind === "assistant" || i.kind === "notice",
          )
          .map((i) => (
            <article key={i.kind + ":" + i.id}>
              <b>
                {i.kind === "user"
                  ? "나"
                  : i.kind === "notice"
                    ? "상태"
                    : providerName(state.provider)}
              </b>
              {i.kind === "assistant" ? (
                <Markdown
                  text={i.text}
                  location={{ hostId: parent.hostId, cwd: parent.cwd }}
                />
              ) : (
                <p>
                  {state.sent.get(i.text) ||
                    (i.kind === "user"
                      ? i.text.split(
                          "\n\n[원래 대화에서 인용 · " +
                            parent.nativeId +
                            "]\n",
                          1,
                        )[0]
                      : i.text)}
                </p>
              )}
            </article>
          ))}
        {child?.error && <p role="alert">{child.error}</p>}
      </div>
      {child?.approvals.map((approval) => (
        <ApprovalCard
          key={child.id + ":" + approval.id}
          approval={approval}
          questionsOnly
          onAnswer={(input) =>
            control("/approvals/" + encodeURIComponent(approval.id), input)
          }
        />
      ))}
      {running && (
        <div className="side-chat-status">
          <small role="status">
            {child?.status === "waiting" ? "확인 대기" : "응답 중…"}
          </small>
          <button
            type="button"
            disabled={state.stopping}
            onClick={async () => {
              if (state.stopping) return;
              state.stopping = true;
              repaint();
              try {
                await control("/interrupt", {});
              } catch (e) {
                state.error = (e as Error).message;
              } finally {
                state.stopping = false;
                repaint();
              }
            }}
          >
            옆 응답 중단
          </button>
        </div>
      )}
      {!running && !state.busy && answer && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => append(answer.text)}
        >
          답을 원래 초안에 담기
        </button>
      )}
      {(state.error || state.readError) && (
        <p role="alert">{state.error || state.readError}</p>
      )}
      {state.recover &&
        (state.error ? (
          <button
            type="button"
            onClick={() => {
              state.recover = undefined;
              state.error = undefined;
              state.readError = undefined;
              state.createId = crypto.randomUUID();
              state.quote = sideContext(parent, selection());
              if (state.storageScope)
                try {
                  localStorage.removeItem(
                    "harbor.side.v1." + state.storageScope,
                  );
                } catch {}
              repaint();
            }}
          >
            새 옆 대화
          </button>
        ) : (
          <small role="status">옆 대화에 다시 연결 중…</small>
        ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {state.quote && (
          <details>
            <summary>인용한 원문</summary>
            <pre>{state.quote}</pre>
            <button
              type="button"
              onClick={() => {
                state.quote = undefined;
                repaint();
              }}
            >
              인용 제외
            </button>
          </details>
        )}
        <textarea
          rows={3}
          aria-label="옆 대화 메시지"
          placeholder="옆 대화에 질문…"
          maxLength={16000}
          value={state.draft}
          onChange={(e) => {
            state.draft = e.target.value;
            if (state.storageScope)
              writeManagedTabDraft(state.storageScope, "side", state.draft);
            repaint();
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const picked = selection().trim();
              if (picked) {
                state.quote = picked.slice(0, 16000);
                state.error = undefined;
              } else state.error = "원래 대화에서 인용할 부분을 선택하세요.";
              repaint();
            }}
          >
            선택 인용
          </button>
          <button
            type="submit"
            aria-label="옆 대화 보내기"
            disabled={
              !active ||
              !!state.recover ||
              !state.draft.trim() ||
              state.busy ||
              running
            }
          >
            보내기
          </button>
        </div>
      </form>
    </section>
  );
}

export function ManagedSideRail({
  storageScope,
  state,
  parent,
  provider,
  hostId,
  active,
  request,
  selection,
  append,
}: {
  storageScope?: string;
  state: SideChatState;
  parent?: IdeChatConversation;
  provider: IdeChatConversation["provider"];
  hostId: string;
  active: boolean;
  request: IdeChatRequest;
  selection: () => string;
  append: (text: string) => void;
}) {
  const [, redraw] = useState(0);
  if (storageScope) restore(state, storageScope);
  const toggle = (open: boolean) => {
    if (open && !parent) return;
    if (open && parent && !state.started) {
      state.provider = parent.provider === "claude" ? "claude" : "codex";
      state.quote = sideContext(parent, selection());
      state.started = true;
    }
    state.open = open;
    redraw((n) => n + 1);
  };
  return (
    <TerminalUsageBar
      managedId={parent?.id}
      managedRequest={request}
      hostId={hostId}
      provider={parent?.provider || provider}
      sessionId={parent?.nativeId}
      active={active}
      working={parent?.status === "running"}
      waiting={parent?.status === "waiting"}
      managedStatus={parent?.status}
      managedModel={parent?.model}
      sideChat={{
        enabled: !!parent,
        open: !!parent && state.open,
        toggle,
        pane: parent ? (
          <SidePane
            key={parent.id}
            state={state}
            parent={parent}
            request={request}
            selection={selection}
            append={append}
            active={active}
          />
        ) : null,
      }}
    />
  );
}
