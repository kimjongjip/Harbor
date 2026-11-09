import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  X,
  FileCode2,
  FolderOpen,
  TerminalSquare,
} from "lucide-react";
import type { Approval, MessageItem, TerminalInfo } from "../../shared/types";
import type { HistoryThread } from "../../shared/history";
import type {
  IdeChatAnswer,
  IdeChatConversation,
  IdeChatCreate,
  IdeChatHistory,
  IdeChatProvider,
  IdeChatReceipt,
  IdeChatSend,
} from "../../shared/ide-chat";
import type { IdeSelection } from "./types";
import { getToken } from "../api";
import { Markdown } from "../RichMarkdown";
import { isLegacyClaudeHistoryLimit } from "../history-errors";
import { userMessageView, userOriginLabel } from "../user-origin";
import "./chat.css";

export type IdeChatRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;
const localRequest: IdeChatRequest = (path, init) =>
  fetch(`/api/ide-chat${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Harbor-Token": getToken(),
      ...init?.headers,
    },
  });
export interface IdeChatAttachment {
  id: string;
  selection: IdeSelection;
}
type RenderChatMarkdown = (
  text: string,
  location: { hostId: string; cwd: string },
) => ReactNode;
interface ChatDraft {
  key: string;
  hostId: string;
  provider: IdeChatProvider;
  draft: string;
  cwd: string;
  model: string;
  conversation?: IdeChatConversation;
  attachment?: IdeSelection;
  createRequestId: string;
  createAttempt?: IdeChatCreate;
  attempt?: IdeChatSend;
  sending: boolean;
  loadingOlder?: boolean;
  stopping?: boolean;
  error?: string;
  connectionError?: string;
  notice?: string;
  historyPaused?: boolean;
  historyRetryId?: string;
}
function selectionPrompt(text: string, selection?: IdeSelection) {
  if (!selection) return text;
  return `${text}\n\n<editor_selection>\n${JSON.stringify({ path: selection.path, startLine: selection.startLine, endLine: selection.endLine, unsaved: selection.unsaved, text: selection.text }, null, 2)}\n</editor_selection>`;
}
function displayMessage(item: MessageItem): {
  text: string;
  selection?: Pick<
    IdeSelection,
    "path" | "startLine" | "endLine" | "unsaved" | "text"
  >;
} {
  if (item.kind !== "user") return { text: item.text };
  const match = item.text.match(
    /\n\n<editor_selection>\n([\s\S]+)\n<\/editor_selection>$/,
  );
  if (!match) return { text: item.text };
  try {
    const selection = JSON.parse(match[1]);
    if (
      typeof selection.path !== "string" ||
      typeof selection.text !== "string" ||
      !Number.isInteger(selection.startLine) ||
      !Number.isInteger(selection.endLine)
    )
      return { text: item.text };
    return { text: item.text.slice(0, match.index), selection };
  } catch {
    return { text: item.text };
  }
}
const ChatItem = memo(
  function ChatItem({
    item,
    conversation,
    renderMarkdown,
  }: {
    item: MessageItem;
    conversation: IdeChatConversation;
    renderMarkdown?: RenderChatMarkdown;
  }) {
    const generated = item.kind === "user" ? userMessageView(item) : undefined;
    if (generated?.hidden) return null;
    if (generated?.origin)
      return (
        <article className="ide-chat-message user generated">
          <strong>{userOriginLabel(generated)}</strong>
          <pre>{generated.text}</pre>
        </article>
      );
    const displayed = displayMessage(item);
    if (item.kind !== "user" && item.kind !== "assistant")
      return (
        <details className="ide-chat-tool">
          <summary>
            {item.kind === "command"
              ? "명령 실행"
              : item.kind === "change"
                ? "파일 변경"
                : "작업 기록"}{" "}
            · {item.text.slice(0, 90)}{" "}
            {item.status === "inProgress" ? "· 실행 중" : ""}
          </summary>
          <pre>
            {item.text}
            {item.detail ? `\n${item.detail}` : ""}
          </pre>
        </details>
      );
    return (
      <article className={`ide-chat-message ${item.kind}`}>
        <strong>
          {item.kind === "user"
            ? "나"
            : conversation.provider === "claude"
              ? "Claude"
              : "Codex"}
        </strong>
        {renderMarkdown ? (
          renderMarkdown(displayed.text, {
            hostId: conversation.hostId,
            cwd: conversation.cwd,
          })
        ) : (
          <Markdown
            text={displayed.text}
            location={{ hostId: conversation.hostId, cwd: conversation.cwd }}
          />
        )}
        {displayed.selection && (
          <details className="ide-chat-quoted">
            <summary>
              <FileCode2 size={12} /> {displayed.selection.path}:
              {displayed.selection.startLine}–{displayed.selection.endLine}
              {displayed.selection.unsaved ? " · 편집 중" : ""}
            </summary>
            <pre>{displayed.selection.text}</pre>
          </details>
        )}
        {!!item.imageCount && <small>첨부 이미지 {item.imageCount}개</small>}
      </article>
    );
  },
  (before, after) =>
    before.renderMarkdown === after.renderMarkdown &&
    before.conversation.hostId === after.conversation.hostId &&
    before.conversation.cwd === after.conversation.cwd &&
    before.conversation.provider === after.conversation.provider &&
    before.item.id === after.item.id &&
    before.item.kind === after.item.kind &&
    before.item.text === after.item.text &&
    before.item.detail === after.item.detail &&
    before.item.status === after.item.status &&
    before.item.imageCount === after.item.imageCount,
);

function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: Approval;
  onAnswer: (answer: Omit<IdeChatAnswer, "runtimeId">) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function answer(value: Omit<IdeChatAnswer, "runtimeId">) {
    setBusy(true);
    setError("");
    try {
      await onAnswer(value);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ide-chat-approval" aria-label="AI 확인 요청">
      <strong>
        <ShieldCheck size={15} />
        {approval.title}
      </strong>
      {approval.detail && <pre>{approval.detail}</pre>}
      {approval.kind === "question" &&
        approval.questions?.map((question) => (
          <div className="ide-chat-question" key={question.id}>
            <span>{question.question}</span>
            <div>
              {question.options?.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  title={option.description}
                  aria-pressed={answers[question.id] === option.label}
                  onClick={() =>
                    setAnswers((old) => ({
                      ...old,
                      [question.id]: option.label,
                    }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <input
              aria-label={question.question}
              value={answers[question.id] || ""}
              onChange={(event) =>
                setAnswers((old) => ({
                  ...old,
                  [question.id]: event.target.value,
                }))
              }
            />
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
      <div className="ide-chat-approval-actions">
        {approval.kind !== "question" && (
          <button
            disabled={busy}
            onClick={() => void answer({ approved: false })}
          >
            거절
          </button>
        )}
        <button
          disabled={
            busy ||
            approval.kind === "unsupported" ||
            (approval.kind === "question" &&
              !!approval.questions?.some(
                (question) => !answers[question.id]?.trim(),
              ))
          }
          onClick={() =>
            void answer(
              approval.kind === "question" ? { answers } : { approved: true },
            )
          }
        >
          {busy
            ? "전송 중…"
            : approval.kind === "question"
              ? "답변 보내기"
              : "이번만 허용"}
        </button>
      </div>
    </section>
  );
}

export default function IdeChatPanel({
  hostId: suppliedHostId,
  hostName,
  terminal,
  active,
  request = localRequest,
  renderMarkdown,
  attachment,
  onAttachmentConsumed,
  onFocusTerminal,
  onShowTerminal,
}: {
  hostId?: string;
  hostName?: string;
  terminal?: TerminalInfo;
  active: boolean;
  onFocusTerminal?: (id: string) => void;
  onShowTerminal?: () => void;
  request?: IdeChatRequest;
  renderMarkdown?: RenderChatMarkdown;
  attachment?: IdeChatAttachment;
  onAttachmentConsumed?: (id: string) => void;
}) {
  const hostId = suppliedHostId || terminal?.hostId || "";
  const [provider, setProvider] = useState<IdeChatProvider>("codex"),
    [, update] = useState(0);
  const [historyRetry, retryHistory] = useState(0);
  const entries = useRef(new Map<string, ChatDraft>()),
    selectedByScope = useRef(new Map<string, string>()),
    mounted = useRef(true);
  const scope = `${hostId}:${provider}`;
  function fresh(): ChatDraft {
    const key = crypto.randomUUID();
    const value: ChatDraft = {
      key,
      hostId,
      provider,
      draft: "",
      cwd: "",
      model: "",
      createRequestId: crypto.randomUUID(),
      sending: false,
    };
    entries.current.set(key, value);
    selectedByScope.current.set(scope, key);
    return value;
  }
  const view =
    entries.current.get(selectedByScope.current.get(scope) || "") || fresh();
  const selected = useRef(view.key);
  selected.current = view.key;
  const repaint = () => {
    if (mounted.current) update((value) => value + 1);
  };
  const [historyOpen, setHistoryOpen] = useState(false),
    [history, setHistory] = useState<HistoryThread[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyQuery, setHistoryQuery] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState(""),
    [historyVersion, reloadHistory] = useState(0);
  const historyGeneration = useRef(0),
    historyPending = useRef(false),
    resumes = useRef(new Map<string, string>());
  const [resuming, setResuming] = useState(""),
    [folderOpen, setFolderOpen] = useState(false),
    [bottom, setBottom] = useState(true);
  const [terminalIntent, setTerminalIntent] = useState<{
    hostId: string;
    provider: IdeChatProvider;
    terminalId: string;
    nativeId: string;
    automatic?: boolean;
  }>();
  const currentTerminal =
    terminal?.hostId === hostId &&
    !terminal.exited &&
    terminal.agentKind &&
    terminal.agentSessionId
      ? terminal
      : undefined;
  const currentTerminalKey = currentTerminal
    ? JSON.stringify([
        hostId,
        currentTerminal.id,
        currentTerminal.agentKind,
        currentTerminal.agentSessionId,
      ])
    : "";
  const terminalBinding = useRef(currentTerminalKey);
  terminalBinding.current = currentTerminalKey;
  const automaticAttachments = useRef(new Set<string>()),
    freshScopes = useRef(new Set<string>());
  const scroll = useRef<HTMLDivElement>(null),
    following = useRef(true),
    prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const consumed = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setHistoryOpen(false);
    setHistory([]);
    setHistoryCursor(null);
    setHistoryQuery("");
    setHistoryError("");
    setResuming("");
    historyGeneration.current++;
  }, [scope]);
  useLayoutEffect(() => {
    following.current = true;
    setBottom(true);
    prepend.current = undefined;
  }, [view.key]);
  useEffect(() => {
    if (
      !attachment ||
      consumed.current.has(attachment.id) ||
      attachment.selection.hostId !== hostId
    )
      return;
    consumed.current.add(attachment.id);
    view.attachment = attachment.selection;
    repaint();
    onAttachmentConsumed?.(attachment.id);
  }, [attachment, hostId, view.key]);

  async function call<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    terminalId?: string,
  ): Promise<T> {
    const response = await request(path, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(terminalId ? { "X-Harbor-Terminal": terminalId } : {}),
            },
            body: JSON.stringify(body),
          }),
      signal: signal || AbortSignal.timeout(45000),
    });
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(value.error || "요청을 완료하지 못했습니다."),
        { code: value.code },
      );
    return value;
  }
  function accept(target: ChatDraft, conversation: IdeChatConversation) {
    if (
      conversation.hostId !== target.hostId ||
      conversation.provider !== target.provider ||
      (target.conversation && target.conversation.id !== conversation.id)
    )
      throw new Error(
        "다른 대화의 응답을 받았습니다. 기록에서 다시 선택하세요.",
      );
    if (
      target.conversation?.runtimeId === conversation.runtimeId &&
      target.conversation.revision > conversation.revision
    )
      return;
    if (isLegacyClaudeHistoryLimit(conversation.error)) {
      target.historyPaused = true;
      conversation = {
        ...conversation,
        error: undefined,
        items: conversation.items.length
          ? conversation.items
          : target.conversation?.items || [],
      };
    }
    target.conversation = conversation;
    target.connectionError = undefined;
    repaint();
  }
  useEffect(() => {
    if (!active || !view.conversation || view.historyPaused) return;
    const target = view,
      id = view.conversation.id;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const value = await call<IdeChatConversation>(
          `/conversations/${encodeURIComponent(id)}`,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        );
        if (live) accept(target, value);
      } catch (error) {
        if (live) {
          if (isLegacyClaudeHistoryLimit(error)) {
            target.historyPaused = true;
            target.connectionError = undefined;
          } else target.connectionError = (error as Error).message;
          repaint();
        }
      } finally {
        if (live && !target.historyPaused)
          timer = setTimeout(
            poll,
            target.conversation?.status === "running"
              ? 600
              : target.conversation?.status === "waiting"
                ? 1200
                : 3000,
          );
      }
    }
    void poll();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, view.key, view.conversation?.id, historyRetry, request]);

  useEffect(() => {
    if (!historyOpen || !active || !hostId) return;
    const ticket = ++historyGeneration.current,
      controller = new AbortController();
    setHistoryBusy(true);
    setHistoryError("");
    const timer = setTimeout(
      async () => {
        try {
          const query = new URLSearchParams({
            provider,
            ...(historyQuery.trim() ? { query: historyQuery.trim() } : {}),
          });
          const result = await call<IdeChatHistory>(
            `/hosts/${encodeURIComponent(hostId)}/history?${query}`,
            undefined,
            AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          );
          if (ticket === historyGeneration.current) {
            setHistory(result.data);
            setHistoryCursor(result.nextCursor);
          }
        } catch (error) {
          if (
            ticket === historyGeneration.current &&
            !controller.signal.aborted
          )
            setHistoryError((error as Error).message);
        } finally {
          if (ticket === historyGeneration.current) setHistoryBusy(false);
        }
      },
      historyQuery ? 250 : 0,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (historyGeneration.current === ticket) historyGeneration.current++;
    };
  }, [historyOpen, active, scope, historyQuery, historyVersion, request]);
  async function moreHistory() {
    if (!historyCursor || historyBusy || historyPending.current) return;
    const ticket = historyGeneration.current;
    historyPending.current = true;
    setHistoryBusy(true);
    try {
      const query = new URLSearchParams({
        provider,
        cursor: historyCursor,
        ...(historyQuery.trim() ? { query: historyQuery.trim() } : {}),
      });
      const result = await call<IdeChatHistory>(
        `/hosts/${encodeURIComponent(hostId)}/history?${query}`,
      );
      if (ticket === historyGeneration.current) {
        setHistory((old) => [
          ...new Map(
            [...old, ...result.data].map((item) => [item.id, item]),
          ).values(),
        ]);
        setHistoryCursor(result.nextCursor);
      }
    } catch (error) {
      if (ticket === historyGeneration.current)
        setHistoryError((error as Error).message);
    } finally {
      historyPending.current = false;
      if (ticket === historyGeneration.current) setHistoryBusy(false);
    }
  }
  async function resume(
    thread: Pick<HistoryThread, "id">,
    expectedTerminalKey?: string,
    automatic = false,
  ) {
    if (resuming) return;
    const capturedScope = scope,
      key = `${scope}:${thread.id}`,
      ticket = historyGeneration.current;
    const requestId = resumes.current.get(key) || crypto.randomUUID();
    resumes.current.set(key, requestId);
    setResuming(thread.id);
    setHistoryError("");
    try {
      const conversation = await call<IdeChatConversation>("/conversations", {
        hostId,
        provider,
        resumeId: thread.id,
        requestId,
      } satisfies IdeChatCreate);
      let target = [...entries.current.values()].find(
        (item) =>
          item.conversation?.id === conversation.id &&
          item.hostId === hostId &&
          item.provider === provider,
      );
      if (!target) {
        target = {
          key: crypto.randomUUID(),
          hostId,
          provider,
          draft: "",
          cwd: conversation.cwd,
          model: conversation.model,
          createRequestId: requestId,
          sending: false,
        };
        entries.current.set(target.key, target);
      }
      accept(target, conversation);
      if (
        ticket === historyGeneration.current &&
        (!expectedTerminalKey ||
          terminalBinding.current === expectedTerminalKey) &&
        (!automatic ||
          (!view.draft && !view.attachment && selected.current === view.key))
      ) {
        selectedByScope.current.set(capturedScope, target.key);
        setHistoryOpen(false);
        following.current = true;
        repaint();
      }
    } catch (error) {
      if (ticket === historyGeneration.current) {
        const limited = isLegacyClaudeHistoryLimit(error);
        setHistoryError(limited ? "" : (error as Error).message);
        if (limited) {
          view.historyPaused = true;
          view.historyRetryId = thread.id;
        }
        if (
          expectedTerminalKey &&
          terminalBinding.current === expectedTerminalKey
        ) {
          view.error = limited ? undefined : (error as Error).message;
          repaint();
        }
        if (limited) repaint();
      }
    } finally {
      setResuming((current) => (current === thread.id ? "" : current));
    }
  }
  useEffect(() => {
    if (!terminalIntent || !active) return;
    if (
      terminalIntent.hostId !== hostId ||
      terminalIntent.terminalId !== currentTerminal?.id ||
      terminalIntent.nativeId !== currentTerminal?.agentSessionId
    ) {
      setTerminalIntent(undefined);
      return;
    }
    if (terminalIntent.provider !== provider) return;
    if (resuming) return;
    setTerminalIntent(undefined);
    void resume(
      { id: terminalIntent.nativeId },
      currentTerminalKey,
      terminalIntent.automatic,
    );
  }, [
    terminalIntent,
    active,
    scope,
    currentTerminal?.id,
    currentTerminal?.agentSessionId,
    resuming,
  ]);
  useEffect(() => {
    if (
      !active ||
      !currentTerminal ||
      automaticAttachments.current.has(currentTerminalKey)
    )
      return;
    automaticAttachments.current.add(currentTerminalKey);
    const targetScope = `${hostId}:${currentTerminal.agentKind}`;
    const retained = entries.current.get(
      selectedByScope.current.get(targetScope) || "",
    );
    if (
      freshScopes.current.has(targetScope) ||
      freshScopes.current.has(scope) ||
      view.conversation ||
      view.draft ||
      view.attachment ||
      view.sending ||
      (retained &&
        (retained.conversation ||
          retained.draft ||
          retained.attachment ||
          retained.sending))
    )
      return;
    setProvider(currentTerminal.agentKind!);
    setTerminalIntent({
      hostId,
      provider: currentTerminal.agentKind!,
      terminalId: currentTerminal.id,
      nativeId: currentTerminal.agentSessionId!,
      automatic: true,
    });
  }, [active, currentTerminalKey]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    if (prepend.current) {
      scroll.current.scrollTop =
        prepend.current.top +
        scroll.current.scrollHeight -
        prepend.current.height;
      prepend.current = undefined;
    } else if (following.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view.conversation, view.key, active, historyOpen]);
  async function older() {
    const target = view,
      conversation = target.conversation;
    if (!conversation?.historyCursor || target.loadingOlder) return;
    target.loadingOlder = true;
    target.error = undefined;
    repaint();
    try {
      const result = await call<IdeChatConversation>(
        `/conversations/${encodeURIComponent(conversation.id)}/history`,
        { runtimeId: conversation.runtimeId },
      );
      if (selected.current === target.key && scroll.current)
        prepend.current = {
          top: scroll.current.scrollTop,
          height: scroll.current.scrollHeight,
        };
      if (selected.current === target.key) following.current = false;
      accept(target, result);
    } catch (error) {
      if (isLegacyClaudeHistoryLimit(error)) target.historyPaused = true;
      else target.error = (error as Error).message;
    } finally {
      target.loadingOlder = false;
      repaint();
    }
  }
  async function send() {
    const target = view;
    if (
      !hostId ||
      !target.draft.trim() ||
      target.sending ||
      target.conversation?.live?.canSend === false ||
      (!target.conversation?.live &&
        ["running", "waiting"].includes(target.conversation?.status || ""))
    )
      return;
    const draft = target.draft,
      selection = target.attachment,
      text = selectionPrompt(draft, selection);
    if (text.length > 32000) {
      target.error =
        "선택한 코드와 질문이 너무 깁니다. 선택 범위를 줄여주세요.";
      repaint();
      return;
    }
    target.sending = true;
    target.error = undefined;
    target.notice = undefined;
    repaint();
    try {
      if (!target.conversation) {
        const cwd = target.cwd.trim() || undefined,
          model = target.model.trim() || undefined;
        if (
          target.createAttempt &&
          (target.createAttempt.cwd !== cwd ||
            target.createAttempt.model !== model)
        )
          target.createRequestId = crypto.randomUUID();
        target.createAttempt = {
          hostId: target.hostId,
          provider: target.provider,
          requestId: target.createRequestId,
          ...(cwd ? { cwd } : {}),
          ...(model ? { model } : {}),
        };
        accept(
          target,
          await call<IdeChatConversation>(
            "/conversations",
            target.createAttempt,
          ),
        );
      }
      const conversation = target.conversation!;
      const input: IdeChatSend =
        target.attempt?.text === text &&
        target.attempt.runtimeId === conversation.runtimeId
          ? target.attempt
          : {
              runtimeId: conversation.runtimeId,
              requestId: crypto.randomUUID(),
              text,
            };
      target.attempt = input;
      const receipt = await call<IdeChatReceipt>(
        `/conversations/${encodeURIComponent(conversation.id)}/messages`,
        input,
        undefined,
        conversation.live?.terminalId,
      );
      if (receipt.status === "uncertain")
        target.notice =
          "전송 확인이 지연되고 있습니다. 대화 갱신을 기다려주세요. 같은 내용의 재시도는 중복 전송되지 않습니다.";
      else {
        if (target.draft === draft) target.draft = "";
        if (target.attachment === selection) target.attachment = undefined;
        target.attempt = undefined;
        if (selected.current === target.key) following.current = true;
        if (receipt.status === "queued")
          target.notice = "열린 대화에 전달했습니다. AI가 순서대로 처리합니다.";
      }
      accept(
        target,
        await call<IdeChatConversation>(
          `/conversations/${encodeURIComponent(conversation.id)}`,
        ),
      );
    } catch (error) {
      target.error = (error as Error).message;
    } finally {
      target.sending = false;
      repaint();
    }
  }
  async function answer(
    approvalId: string,
    value: Omit<IdeChatAnswer, "runtimeId">,
  ) {
    const target = view,
      conversation = target.conversation!;
    await call(
      `/conversations/${encodeURIComponent(conversation.id)}/approvals/${encodeURIComponent(approvalId)}`,
      { runtimeId: conversation.runtimeId, ...value },
      undefined,
      conversation.live?.terminalId,
    );
    accept(
      target,
      await call<IdeChatConversation>(
        `/conversations/${encodeURIComponent(conversation.id)}`,
      ),
    );
  }
  async function stop() {
    const target = view,
      conversation = target.conversation;
    if (
      !conversation ||
      target.stopping ||
      conversation.live?.canInterrupt === false
    )
      return;
    target.stopping = true;
    repaint();
    try {
      await call(
        `/conversations/${encodeURIComponent(conversation.id)}/interrupt`,
        { runtimeId: conversation.runtimeId },
        undefined,
        conversation.live?.terminalId,
      );
      accept(
        target,
        await call<IdeChatConversation>(
          `/conversations/${encodeURIComponent(conversation.id)}`,
        ),
      );
    } catch (error) {
      target.error = (error as Error).message;
    } finally {
      target.stopping = false;
      repaint();
    }
  }
  const conversation = view.conversation,
    label = provider === "claude" ? "Claude" : "Codex",
    running = conversation?.status === "running",
    live = conversation?.live;
  function showLiveTerminal() {
    if (!live?.terminalId) return;
    onShowTerminal?.();
    onFocusTerminal?.(live.terminalId);
  }
  return (
    <section className="ide-chat" aria-label="IDE AI 대화">
      <header>
        <select
          aria-label="AI 제공자"
          value={provider}
          onChange={(event) =>
            setProvider(event.target.value as IdeChatProvider)
          }
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
        <span className="ide-chat-host" title={hostName}>
          {hostName || "서버 선택"}
        </span>
        <button
          aria-label="대화 기록"
          title="대화 기록"
          aria-pressed={historyOpen}
          onClick={() => {
            setHistoryOpen(!historyOpen);
            reloadHistory((value) => value + 1);
          }}
        >
          <History size={16} />
          <span>기록</span>
        </button>
        <button
          aria-label="새 대화"
          title="새 대화"
          onClick={() => {
            historyGeneration.current++;
            setTerminalIntent(undefined);
            setResuming("");
            freshScopes.current.add(scope);
            if (currentTerminal)
              freshScopes.current.add(`${hostId}:${currentTerminal.agentKind}`);
            fresh();
            setHistoryOpen(false);
            following.current = true;
            repaint();
          }}
        >
          <Plus size={17} />
        </button>
      </header>
      {currentTerminal && (
        <div className="ide-chat-current-terminal">
          <button
            type="button"
            aria-label="현재 터미널 대화"
            title={`${currentTerminal.title} · ${currentTerminal.agentKind === "claude" ? "Claude" : "Codex"}`}
            disabled={!!resuming}
            aria-pressed={
              conversation?.provider === currentTerminal.agentKind &&
              conversation?.nativeId === currentTerminal.agentSessionId
            }
            onClick={() => {
              freshScopes.current.delete(
                `${hostId}:${currentTerminal.agentKind}`,
              );
              setProvider(currentTerminal.agentKind!);
              setTerminalIntent({
                hostId,
                provider: currentTerminal.agentKind!,
                terminalId: currentTerminal.id,
                nativeId: currentTerminal.agentSessionId!,
              });
            }}
          >
            <TerminalSquare size={14} />{" "}
            {resuming === currentTerminal.agentSessionId
              ? "대화 연결 중…"
              : "현재 터미널 대화"}
          </button>
          <span>{currentTerminal.title}</span>
        </div>
      )}
      <div className="ide-chat-conversation-title">
        <strong>{conversation?.title || "새 대화"}</strong>
        <span>
          {running
            ? "작업 중"
            : conversation?.status === "waiting"
              ? "확인 필요"
              : conversation
                ? ""
                : "질문을 보내면 시작됩니다"}
        </span>
      </div>
      {live && (
        <div className="ide-chat-live" role="status">
          <span>
            <TerminalSquare size={13} />
            {view.connectionError
              ? "대화 갱신 대기 중"
              : conversation?.status === "offline"
                ? "저장된 터미널 대화"
                : "열린 터미널과 연결됨"}
          </span>
          <button
            type="button"
            onClick={showLiveTerminal}
            disabled={!onShowTerminal && !onFocusTerminal}
          >
            {live.canSend || conversation?.status === "offline"
              ? "터미널 보기"
              : "터미널에서 입력"}
          </button>
          {live.reason && <small>{live.reason}</small>}
        </div>
      )}
      {historyOpen && (
        <section className="ide-chat-history" aria-label={`${label} 대화 기록`}>
          <div className="ide-chat-history-search">
            <Search size={14} />
            <input
              aria-label="대화 기록 검색"
              placeholder={`${label} 대화 검색`}
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
            <button
              aria-label="대화 기록 새로고침"
              onClick={() => reloadHistory((value) => value + 1)}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="ide-chat-history-list">
            {historyError && <p role="alert">{historyError}</p>}
            {!historyBusy && !history.length && !historyError && (
              <p>저장된 대화가 없습니다.</p>
            )}
            {history.map((thread) => (
              <button
                className="ide-chat-history-row"
                key={thread.id}
                disabled={!!resuming}
                onClick={() => void resume(thread)}
                title={`${thread.title}\n${thread.cwd}`}
              >
                <b>
                  {resuming === thread.id
                    ? "대화 여는 중…"
                    : thread.title || "제목 없는 대화"}
                </b>
                <span>{thread.preview}</span>
                <small>
                  {thread.active ? "열려 있음 · " : ""}
                  {thread.cwd} ·{" "}
                  {new Date(thread.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
            {historyBusy && <p>기록 불러오는 중…</p>}
            {historyCursor && (
              <button disabled={historyBusy} onClick={() => void moreHistory()}>
                기록 더 보기
              </button>
            )}
          </div>
        </section>
      )}
      <div
        className="ide-chat-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          setBottom(following.current);
        }}
      >
        {!conversation && (
          <div className="ide-chat-empty">
            <div className="ide-chat-empty-icon">
              {provider === "claude" ? "✳" : "⌘"}
            </div>
            <strong>{label}와 새 대화</strong>
            <p>{hostName || "선택한 서버"}에서 질문하거나 작업을 요청하세요.</p>
            <small>이전 대화는 위쪽 기록 버튼에서 이어갈 수 있습니다.</small>
          </div>
        )}
        {conversation?.historyCursor && (
          <button
            className="ide-chat-older"
            disabled={view.loadingOlder}
            onClick={() => void older()}
          >
            {view.loadingOlder ? "불러오는 중…" : "이전 메시지 더 보기"}
          </button>
        )}
        {conversation?.items.map((item) => (
          <ChatItem
            key={item.id}
            item={item}
            conversation={conversation}
            renderMarkdown={renderMarkdown}
          />
        ))}
        {running && (
          <div className="ide-chat-progress">
            <LoaderCircle size={14} className="ide-spinner" />
            {label}가 작업 중입니다.
          </div>
        )}
        {conversation?.approvals.map((approval) => (
          <ApprovalCard
            key={`${conversation.id}:${approval.id}`}
            approval={approval}
            onAnswer={(value) => answer(approval.id, value)}
          />
        ))}
      </div>
      {!bottom && (
        <button
          className="ide-chat-bottom"
          onClick={() => {
            following.current = true;
            if (scroll.current)
              scroll.current.scrollTop = scroll.current.scrollHeight;
          }}
        >
          <ArrowDown size={14} /> 최신 대화
        </button>
      )}
      {(view.error || view.connectionError || conversation?.error) && (
        <div role="alert" className="ide-chat-error">
          {view.error || view.connectionError || conversation?.error}
        </div>
      )}
      {view.notice && (
        <div role="status" className="ide-chat-note">
          {view.notice}
        </div>
      )}
      {conversation?.historyNotice && (
        <div role="status" className="ide-chat-note">
          {conversation.historyNotice}
        </div>
      )}
      {view.historyPaused && (
        <button
          type="button"
          className="ide-chat-older"
          onClick={() => {
            view.historyPaused = false;
            if (view.conversation) retryHistory((value) => value + 1);
            else if (view.historyRetryId)
              void resume({ id: view.historyRetryId });
            repaint();
          }}
        >
          기록 다시 불러오기
        </button>
      )}
      <form
        className="ide-chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {view.attachment && (
          <div className="ide-chat-attachment">
            <FileCode2 size={14} />
            <span title={view.attachment.text}>
              {view.attachment.path.split(/[\\/]/).pop()}:
              {view.attachment.startLine}–{view.attachment.endLine}
              {view.attachment.unsaved ? " · 편집 중" : ""}
            </span>
            <button
              type="button"
              aria-label="선택한 코드 제외"
              onClick={() => {
                view.attachment = undefined;
                repaint();
              }}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <textarea
          aria-label="AI에게 보낼 메시지"
          placeholder={
            live?.canSend === false
              ? "이 대화의 입력은 열린 터미널에서 계속하세요."
              : `${label}에게 질문하거나 작업 요청…`
          }
          value={view.draft}
          maxLength={32000}
          disabled={!hostId || live?.canSend === false}
          onChange={(event) => {
            view.draft = event.target.value;
            repaint();
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div>
          <button
            type="button"
            aria-label="대화 작업 폴더 설정"
            aria-expanded={folderOpen}
            title={conversation?.cwd || view.cwd || "서버 홈 폴더"}
            onClick={() => setFolderOpen(!folderOpen)}
          >
            <FolderOpen size={14} />
          </button>
          <small>
            {live?.canSend === false
              ? "입력·승인은 열린 터미널에서"
              : "Enter 전송 · Shift+Enter 줄바꿈"}
          </small>
          {(running || conversation?.status === "waiting") &&
          live?.canInterrupt !== false ? (
            <button
              type="button"
              aria-label="AI 작업 중단"
              disabled={view.stopping}
              onClick={() => void stop()}
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="AI 메시지 전송"
              disabled={
                !hostId ||
                !view.draft.trim() ||
                view.sending ||
                live?.canSend === false
              }
            >
              {view.sending ? (
                <LoaderCircle size={17} className="ide-spinner" />
              ) : (
                <ArrowUp size={17} />
              )}
            </button>
          )}
        </div>
        {folderOpen && (
          <div className="ide-chat-options">
            <label>
              작업 폴더
              <input
                aria-label="AI 작업 폴더"
                placeholder="서버 홈 폴더 (~)"
                value={conversation?.cwd || view.cwd}
                disabled={!!conversation || view.sending}
                onChange={(event) => {
                  view.cwd = event.target.value;
                  repaint();
                }}
              />
            </label>
            <label>
              모델
              <input
                aria-label="AI 모델"
                placeholder="계정 기본 모델"
                value={conversation?.model || view.model}
                disabled={!!conversation || view.sending}
                onChange={(event) => {
                  view.model = event.target.value;
                  repaint();
                }}
              />
            </label>
          </div>
        )}
      </form>
    </section>
  );
}
