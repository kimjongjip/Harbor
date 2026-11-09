import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { MobileState } from "../../shared/mobile";
import type { HarborRequest } from "../../shared/requests";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import { restoreTerminalReplay, writeTerminal } from "../terminalReplay";
import { terminalPathForPaste } from "../terminalClipboard";
import { MobileTerminalRich } from "./MobileTerminalRich";
import { MobileConversation } from "./MobileConversation";
import { MobileScreenCache } from "./screen-cache";
import { MobileNotifications } from "./MobileNotifications";
import { useSharedInputControl } from "./useSharedInputControl";
import {
  MobileSessionPreloader,
  mobileScreenKey,
  previewIdentity,
  type MobilePreview,
} from "./session-preloader";
import { mobileTerminalViewport } from "./terminal-viewport";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  Inbox,
  Keyboard,
  Paperclip,
  Search,
  Settings,
  Terminal as TerminalIcon,
  Layers,
  X,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "katex/dist/katex.min.css";
import "./mobile.css";

async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const res = await fetch(`/mobile-api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "X-Harbor-Mobile": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}
async function preloadScreen(
  identity: Omit<MobilePreview, "data" | "replay">,
  signal: AbortSignal,
): Promise<MobilePreview> {
  const query = new URLSearchParams({
    runtimeId: identity.runtimeId,
    sessionId: identity.sessionId,
  });
  const response = await fetch(
    `/mobile-api/terminals/${encodeURIComponent(identity.terminalId)}/preview?${query}`,
    {
      credentials: "same-origin",
      headers: { "X-Harbor-Mobile": "1" },
      signal,
    },
  );
  if (!response.ok) throw new Error("화면 준비 실패");
  return response.json();
}
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>[이미지: {alt}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
function sessionStatus(t: MobileState["terminals"][number]) {
  if (t.exited) return "종료됨";
  if (t.connectionState !== "connected") return "연결 확인 필요";
  if (t.agentState === "working") return "작업 중";
  if (t.agentState === "waiting") return "확인 필요";
  return "입력 가능";
}
function initialTerminal() {
  const query = new URLSearchParams(location.search).get("terminal");
  if (query !== null) return query;
  try {
    return sessionStorage.getItem("harbor.mobile.terminal") || "";
  } catch {
    return "";
  }
}
function RequestCard({
  item,
  done,
  enabled,
  authorize,
}: {
  item: HarborRequest;
  done: () => void;
  enabled: boolean;
  authorize(): Promise<{ clientId?: string; controlToken?: string }>;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function answer(optionId?: string) {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      const credentials = await authorize();
      await api(`/requests/${item.id}/answer`, {
        text,
        optionId,
        ...credentials,
      });
      done();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="card">
      <small>
        {item.terminal.title} ·{" "}
        {item.kind === "permission" ? "승인 요청" : "질문"}
      </small>
      <h3>{item.title}</h3>
      <p>{item.question}</p>
      {item.permission?.command && <pre>{item.permission.command}</pre>}
      {item.permission?.detail && (
        <details>
          <summary>요청 내용</summary>
          <pre>{item.permission.detail}</pre>
        </details>
      )}
      <textarea
        aria-label="요청에 답변"
        placeholder="답변 또는 의견"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        {item.options.map((o) => (
          <button
            key={o.id}
            disabled={busy || !enabled}
            onClick={() => void answer(o.id)}
          >
            {o.label}
          </button>
        ))}
        {item.kind !== "permission" && (
          <button
            disabled={busy || !enabled || !text.trim()}
            onClick={() => void answer()}
          >
            답변 보내기
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
function App() {
  const [state, setState] = useState<MobileState>(),
    [selected, setSelected] = useState(initialTerminal);
  const [tab, setTab] = useState<"sessions" | "terminal" | "settings">(
    selected ? "terminal" : "sessions",
  );
  const [status, setStatus] = useState("연결 확인 중"),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [sharedControl, setSharedControl] = useState(false),
    [preview, setPreview] = useState(false),
    [paired, setPaired] = useState(false);
  const [pairCode, setPairCode] = useState(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get("pair") || "";
    if (location.hash)
      history.replaceState(null, "", location.pathname + location.search);
    return code;
  });
  const [name, setName] = useState("내 iPhone"),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState(""),
    [font, setFont] = useState(() => {
      try {
        const saved = Number(localStorage.getItem("harbor.mobile.font"));
        if (saved >= 10 && saved <= 24) return saved;
      } catch {}
      return 14;
    }),
    [answers, setAnswers] = useState<RichTerminalBlock[]>([]),
    [answerError, setAnswerError] = useState(""),
    [answerRevision, setAnswerRevision] = useState(0),
    [nativeTerminal, setNativeTerminal] = useState<Terminal>();
  const [keysOpen, setKeysOpen] = useState(false),
    [viewOptions, setViewOptions] = useState(false),
    [keyboardOpen, setKeyboardOpen] = useState(false),
    [query, setQuery] = useState(""),
    [following, setFollowing] = useState(true),
    [unread, setUnread] = useState(false);
  const [hideClaudeMods, setHideClaudeMods] = useState(() => {
    try {
      return localStorage.getItem("harbor.mobile.hideClaudeMods") !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "harbor.mobile.hideClaudeMods",
        String(hideClaudeMods),
      );
    } catch {}
  }, [hideClaudeMods]);
  const hostRef = useRef<HTMLDivElement>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    inputRef = useRef<HTMLTextAreaElement>(null),
    viewportRef = useRef<ReturnType<typeof mobileTerminalViewport> | undefined>(
      undefined,
    ),
    terminalFollowRef = useRef(true),
    termRef = useRef<Terminal | undefined>(undefined),
    socketRef = useRef<WebSocket | undefined>(undefined),
    reuseSocket = useRef(false),
    canPreload = useRef(false),
    preloader = useRef(new MobileSessionPreloader(preloadScreen)),
    pendingNotification = useRef<string | undefined>(undefined),
    screenCache = useRef(new MobileScreenCache()),
    drafts = useRef(new Map<string, string>()),
    draftSessions = useRef(new Map<string, string | undefined>()),
    readyRef = useRef(false);
  const openTerminals = state?.terminals.filter((t) => !t.exited) || [];
  const terminal = openTerminals.find((t) => t.id === selected);
  const control = useSharedInputControl({
    enabled: sharedControl,
    active: paired && tab === "terminal",
    ready,
    state,
    terminal,
    api,
    update: (id, next) =>
      setState((current) => {
        if (!current) return current;
        const controls = { ...current.controls };
        if (next) controls[id] = next;
        else delete controls[id];
        return { ...current, controls };
      }),
  });
  const cacheKey = mobileScreenKey(
    state?.runtimeId,
    selected,
    terminal?.agentSessionId || terminal?.resumeThreadId,
  );
  terminalFollowRef.current = following;
  const setTerminalFlow = useCallback(
    (node: HTMLElement | null) => viewportRef.current?.setFlow(node),
    [],
  );
  const currentAnswers = answers.filter(
    (a) => !terminal?.agentSessionId || a.sessionId === terminal.agentSessionId,
  );
  useEffect(() => {
    const viewport = window.visualViewport;
    const size = () => {
      document.documentElement.style.setProperty(
        "--mobile-height",
        `${viewport?.height || window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--mobile-top",
        `${viewport?.offsetTop || 0}px`,
      );
      setKeyboardOpen(!!viewport && window.innerHeight - viewport.height > 120);
    };
    size();
    viewport?.addEventListener("resize", size);
    viewport?.addEventListener("scroll", size);
    return () => {
      viewport?.removeEventListener("resize", size);
      viewport?.removeEventListener("scroll", size);
    };
  }, []);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.style.height = "0px";
      input.style.height = `${Math.max(44, Math.min(132, input.scrollHeight))}px`;
    }
  }, [draft, paired]);
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("terminal", selected);
    else url.searchParams.delete("terminal");
    history.replaceState(null, "", url.pathname + url.search);
    try {
      sessionStorage.setItem("harbor.mobile.terminal", selected);
    } catch {}
  }, [selected]);
  useEffect(() => {
    if (
      state &&
      selected &&
      !state.terminals.some((t) => t.id === selected && !t.exited)
    ) {
      setSelected("");
      setTab("sessions");
    }
  }, [state, selected]);
  useLayoutEffect(() => {
    viewportRef.current?.refresh();
  }, [tab, keyboardOpen, keysOpen]);
  const pending =
    state?.requests.filter(
      (r) =>
        r.status === "pending" &&
        openTerminals.some((t) => t.id === r.terminal.terminalId),
    ) || [];
  useEffect(() => {
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .register("/mobile/sw.js", { scope: "/mobile/" })
        .catch(() => {});
    if (!pairCode) void refresh();
  }, []);
  async function refresh() {
    try {
      let next: MobileState;
      if (paired) next = await api("/state");
      else {
        // The authenticated websocket already sends state. Avoid a separate
        // HTTP round trip before opening the same terminal connection.
        const socket = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/mobile-ws`,
        );
        try {
          next = await new Promise<MobileState>((resolve, reject) => {
            const timer = setTimeout(() => {
              socket.close();
              reject(new Error("연결 확인 시간 초과"));
            }, 10000);
            socket.onmessage = (event) => {
              try {
                const message = JSON.parse(event.data);
                if (message.type !== "state") return;
                clearTimeout(timer);
                reuseSocket.current = message.protocol >= 2;
                canPreload.current = message.protocol >= 3;
                setSharedControl(message.protocol >= 4);
                socketRef.current?.close();
                socketRef.current = socket;
                socket.onmessage = null;
                resolve(message.state);
              } catch {
                clearTimeout(timer);
                socket.close();
                reject(new Error("접속 확인 실패"));
              }
            };
            socket.onclose = () => {
              clearTimeout(timer);
              reject(new Error("기기 연결을 확인하세요."));
            };
            socket.onerror = () => socket.close();
          });
        } catch {
          socket.close();
          next = await api("/state");
        }
      }
      setState(next);
      setPaired(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setStatus("접속 확인 필요");
    }
  }
  async function pair() {
    setBusy(true);
    try {
      await api("/pair", { code: pairCode, name });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    drafts.current.set(selected, draft);
  }, [draft]);
  function choose(id: string) {
    if (id !== selected) {
      readyRef.current = false;
      setReady(false);
      setPreview(false);
    }
    drafts.current.set(selected, draft);
    setDraft(drafts.current.get(id) || "");
    setSelected(id);
    setTab("terminal");
    setViewOptions(false);
    setKeysOpen(false);
    viewportRef.current?.latest();
    setError("");
  }
  function prepare(id: string) {
    if (
      !paired ||
      !canPreload.current ||
      !state ||
      document.visibilityState !== "visible"
    )
      return;
    const identity = previewIdentity(state, id);
    if (identity) void preloader.current.prepare(identity);
  }
  // Prepare one likely destination while the list is visible. Pointer/focus intent
  // can replace it; live subscription and the PC terminal are never switched here.
  const candidate = state?.terminals.find(
    (t) =>
      !t.exited &&
      t.connectionState === "connected" &&
      t.id !== selected &&
      (!query ||
        `${t.title} ${state.hosts.find((h) => h.id === t.hostId)?.name || ""}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const candidateKey =
    candidate &&
    mobileScreenKey(
      state?.runtimeId,
      candidate.id,
      candidate.agentSessionId || candidate.resumeThreadId,
    );
  useEffect(() => {
    if (!paired || tab !== "sessions" || !candidate) return;
    const timer = setTimeout(() => prepare(candidate.id), 250);
    return () => clearTimeout(timer);
  }, [paired, tab, candidateKey, query]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== "visible") preloader.current.cancel();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.data?.type !== "harbor-open" ||
        typeof event.data.url !== "string"
      )
        return;
      try {
        const url = new URL(event.data.url);
        if (url.origin !== location.origin || url.pathname !== "/mobile/")
          return;
        const id = url.searchParams.get("terminal");
        if (!id) return;
        if (
          paired &&
          !busy &&
          state?.terminals.some((t) => t.id === id && !t.exited)
        )
          choose(id);
        else pendingNotification.current = id;
      } catch {}
    };
    navigator.serviceWorker?.addEventListener("message", receive);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", receive);
  }, [paired, busy, selected, draft, state]);
  useEffect(() => {
    const id = pendingNotification.current;
    if (!id || !paired || busy || !state) return;
    pendingNotification.current = undefined;
    if (state.terminals.some((t) => t.id === id && !t.exited)) choose(id);
    else {
      setTab("sessions");
      setError("알림의 세션이 이미 닫혔습니다.");
    }
  }, [paired, busy, state]);
  useEffect(() => {
    if (!paired || !hostRef.current || !scrollRef.current) return;
    const term = new Terminal({
      disableStdin: true,
      cols: 100,
      rows: 30,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: font,
      lineHeight: 1.35,
      scrollback: 10000,
      theme: {
        background: "#ffffff",
        foreground: "#182235",
        selectionBackground: "#a5c5f5",
      },
    });
    term.open(hostRef.current);
    const viewport = mobileTerminalViewport(
      term,
      scrollRef.current,
      hostRef.current,
      (follow, fresh) => {
        setFollowing(follow);
        setUnread(fresh);
      },
    );
    viewportRef.current = viewport;
    termRef.current = term;
    setNativeTerminal(term);
    let disposed = false,
      retry: ReturnType<typeof setTimeout>,
      attempt = 0,
      openedAt = 0,
      lastMessage = 0,
      generation = 0;
    const controller = new AbortController();
    let queue = Promise.resolve(),
      queuedBytes = 0,
      liveReceived = false;
    const markReady = (value: boolean) => {
      readyRef.current = value;
      setReady(value);
      if (value) setPreview(false);
    };
    markReady(false);
    setPreview(false);
    const cached = screenCache.current.get(cacheKey);
    const showPreview = (
      data: string,
      replay: MobilePreview["replay"] | undefined,
    ) => {
      queue = queue
        .then(async () => {
          if (disposed || liveReceived) return;
          viewport.beforeReplay();
          const restored = await restoreTerminalReplay(
            term,
            data,
            replay,
            () => !disposed,
            undefined,
            controller.signal,
          );
          if (restored) {
            viewport.afterReplay();
            setPreview(true);
            setStatus("이전 화면 · 최신 내용 확인 중");
          }
        })
        .catch(() => {});
    };
    if (cached?.data !== undefined) showPreview(cached.data, cached.replay);
    const prepared = preloader.current.take(cacheKey, controller.signal);
    void prepared?.then((value) => {
      if (!value || disposed || liveReceived) return;
      screenCache.current.snapshot(cacheKey, value.data, value.replay);
      showPreview(value.data, value.replay);
    });
    const connect = () => {
      if (disposed) return;
      clearTimeout(retry);
      const current = ++generation;
      markReady(false);
      setStatus(
        cached?.data !== undefined
          ? "이전 화면 · 최신 내용 확인 중"
          : "다시 연결 중",
      );
      openedAt = lastMessage = Date.now();
      const previous = socketRef.current;
      const socket =
        reuseSocket.current && previous?.readyState === WebSocket.OPEN
          ? previous
          : new WebSocket(
              `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/mobile-ws`,
            );
      if (previous && previous !== socket) previous.close();
      const subscriptionId = reuseSocket.current
        ? crypto.randomUUID()
        : undefined;
      socketRef.current = socket;
      const opened = () => {
        if (disposed || current !== generation) return;
        setStatus(
          cached?.data !== undefined
            ? "이전 화면 · 최신 내용 확인 중"
            : "화면 불러오는 중",
        );
        if (selected)
          socket.send(
            JSON.stringify({ type: "subscribe", id: selected, subscriptionId }),
          );
        else {
          setStatus("연결됨");
          attempt = 0;
        }
      };
      socket.onopen = opened;
      socket.onmessage = (event) => {
        if (disposed || current !== generation) return;
        lastMessage = Date.now();
        let value: any;
        try {
          value = JSON.parse(event.data);
        } catch {
          return;
        }
        if (value.type === "state") {
          reuseSocket.current = value.protocol >= 2;
          canPreload.current = value.protocol >= 3;
          setSharedControl(value.protocol >= 4);
          setState(value.state);
          return;
        }
        if (value.type === "heartbeat") return;
        if (subscriptionId && value.subscriptionId !== subscriptionId) return;
        if (value.type === "error") {
          setError(value.error);
          markReady(false);
          socket.close();
          return;
        }
        if (value.id !== selected) return;
        if (value.type === "snapshot") liveReceived = true;
        queuedBytes += event.data.length;
        if (queuedBytes > 12 * 1024 * 1024) {
          socket.close();
          return;
        }
        queue = queue
          .then(async () => {
            if (disposed || current !== generation) return;
            if (value.type === "snapshot") {
              screenCache.current.snapshot(cacheKey, value.data, value.replay);
              viewport.beforeReplay();
              const restored = await restoreTerminalReplay(
                term,
                value.data,
                value.replay,
                () => !disposed && current === generation,
                undefined,
                controller.signal,
              );
              if (restored) {
                viewport.afterReplay();
                setAnswerRevision((value) => value + 1);
                markReady(true);
                setStatus("연결됨");
                attempt = 0;
              }
            } else if (value.type === "data") {
              screenCache.current.append(cacheKey, value.data);
              await writeTerminal(term, value.data, controller.signal);
              viewport.output();
            } else if (value.type === "resize") {
              screenCache.current.resize(cacheKey, value.cols, value.rows);
              term.resize(value.cols, value.rows);
            }
          })
          .catch(() => {
            if (!disposed && current === generation) {
              markReady(false);
              socket.close();
            }
          })
          .finally(() => {
            queuedBytes -= event.data.length;
          });
      };
      socket.onclose = (e) => {
        if (disposed || current !== generation) return;
        markReady(false);
        if (e.code === 4001) {
          setPaired(false);
          setError("기기 연결이 해제됐습니다. PC에서 다시 등록하세요.");
          return;
        }
        setStatus("연결 끊김 · 자동 재연결");
        retry = setTimeout(
          connect,
          Math.min(15000, 800 * 2 ** Math.min(attempt++, 5)),
        );
      };
      socket.onerror = () => socket.close();
      if (socket.readyState === WebSocket.OPEN) opened();
    };
    const wake = () => {
      if (document.visibilityState === "visible") {
        socketRef.current?.close();
        connect();
      }
    };
    const watchdog = setInterval(() => {
      if (
        Date.now() - lastMessage > 45000 ||
        (!readyRef.current && selected && Date.now() - openedAt > 30000)
      ) {
        socketRef.current?.close();
        connect();
      }
    }, 5000);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    connect();
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(watchdog);
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      if (!reuseSocket.current) socketRef.current?.close();
      viewport.dispose();
      viewportRef.current = undefined;
      term.dispose();
      termRef.current = undefined;
      setNativeTerminal(undefined);
    };
  }, [paired, selected, cacheKey]);
  useEffect(() => {
    if (!paired) {
      screenCache.current.clear();
      preloader.current.clear();
      canPreload.current = false;
      setSharedControl(false);
      reuseSocket.current = false;
      return;
    }
    return () => {
      socketRef.current?.close();
      socketRef.current = undefined;
      reuseSocket.current = false;
      preloader.current.clear();
      canPreload.current = false;
    };
  }, [paired]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = font;
    try {
      localStorage.setItem("harbor.mobile.font", String(font));
    } catch {}
  }, [font]);
  useEffect(() => {
    setAnswers(screenCache.current.get(cacheKey)?.blocks || []);
    setAnswerError("");
    viewportRef.current?.latest();
  }, [cacheKey]);
  useEffect(() => {
    if (!paired || !selected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(load, 5000);
        return;
      }
      try {
        const response = await fetch(
          `/mobile-api/terminals/${selected}/answers`,
          {
            credentials: "same-origin",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "답변을 불러오지 못했습니다.");
        if (!cancelled) {
          screenCache.current.answers(cacheKey, data);
          setAnswers(data);
          setAnswerError("");
        }
      } catch (e) {
        if (!cancelled) setAnswerError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [paired, selected, cacheKey, answerRevision]);
  async function send(key?: string, submit = true) {
    if (!inputEnabled || !state || !terminal) return;
    setBusy(true);
    setError("");
    const text = draft,
      target = selected;
    try {
      const credentials = await control.authorize();
      await api("/input", {
        ...credentials,
        requestId: crypto.randomUUID(),
        runtimeId: state.runtimeId,
        terminalId: target,
        sessionId: key
          ? terminal.agentSessionId
          : draftSessions.current.get(target),
        bracketed: termRef.current?.modes.bracketedPasteMode || false,
        ...(key ? { key } : { text }),
        submit,
      });
      if (!key) {
        drafts.current.set(target, "");
        draftSessions.current.delete(target);
        setDraft("");
        viewportRef.current?.latest();
      }
    } catch (e) {
      setError(
        `${(e as Error).message} · 전송 여부를 터미널에서 확인하세요. 초안은 남겨두며 자동으로 재전송하지 않습니다.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function attach(file?: File) {
    if (!file || !terminal || !inputEnabled) return;
    if (file.size > 32 * 1024 * 1024) {
      setError("첨부파일은 32MB까지 지원합니다.");
      return;
    }
    setBusy(true);
    const target = selected;
    if (!drafts.current.get(target))
      draftSessions.current.set(target, terminal.agentSessionId);
    try {
      const credentials = await control.authorize();
      const res = await fetch(
        `/mobile-api/terminals/${target}/attachment?name=${encodeURIComponent(file.name)}`,
        {
          method: "PUT",
          headers: {
            "X-Harbor-Mobile": "1",
            "Content-Type": "application/octet-stream",
            ...(credentials.clientId
              ? { "X-Harbor-Client": credentials.clientId }
              : {}),
            ...(credentials.controlToken
              ? { "X-Harbor-Control": credentials.controlToken }
              : {}),
          },
          body: file,
          signal: AbortSignal.timeout(90000),
        },
      );
      const value = await res.json();
      if (!res.ok) throw new Error(value.error);
      const previous = drafts.current.get(target) || "";
      const next = `${previous}${previous ? "\n" : ""}${terminalPathForPaste(value.path, false)} `;
      drafts.current.set(target, next);
      setDraft(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const inputEnabled =
    ready &&
    !busy &&
    !control.busy &&
    !control.otherOwner &&
    terminal?.connectionState === "connected" &&
    !terminal.exited;
  const selectedHost = state?.hosts.find((h) => h.id === terminal?.hostId);
  const sessionRequests = pending.filter(
    (r) => r.terminal.terminalId === selected,
  );
  const matchingTerminals =
    openTerminals.filter((t) =>
      `${t.title} ${state?.hosts.find((h) => h.id === t.hostId)?.name || ""} ${t.agentKind || ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ) || [];
  return (
    <div className={`mobile-app ${keyboardOpen ? "keyboard-open" : ""}`}>
      <header className="app-header">
        {paired && tab === "terminal" ? (
          <>
            <button
              className="icon-button back-sessions"
              aria-label="세션 목록"
              onClick={() => {
                inputRef.current?.blur();
                setTab("sessions");
              }}
            >
              <ChevronLeft size={22} />
            </button>
            <div className="session-picker">
              <strong>
                {terminal?.title || "세션 선택"} <ChevronDown size={14} />
              </strong>
              <small>
                {selectedHost?.name || "내 세션"} ·{" "}
                {terminal ? sessionStatus(terminal) : "열린 세션을 선택하세요"}
              </small>
              <select
                aria-label="세션 전환"
                value={selected}
                disabled={busy}
                onChange={(e) => choose(e.target.value)}
              >
                <option value="" disabled>
                  세션 선택
                </option>
                {state?.hosts.map((host) => (
                  <optgroup key={host.id} label={host.name}>
                    {openTerminals
                      .filter((t) => t.hostId === host.id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title} · {sessionStatus(t)}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div className="brand">
            <b>Harbor</b>
            <span className="mobile-badge">Mobile</span>
          </div>
        )}
        <small
          className={`connection-status ${status === "연결됨" ? "online" : ""}`}
          role="status"
        >
          {status}
        </small>
      </header>
      {error && (
        <div role="alert" className="notice">
          <span>{error}</span>
          <button aria-label="안내 닫기" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {!paired ? (
        <main className="page">
          <h1>내 Harbor에 연결</h1>
          <p>PC Harbor의 휴대폰 버튼에서 만든 연결 링크를 이 기기로 여세요.</p>
          <label>
            PC에서 복사한 연결 링크
            <input
              aria-label="기기 연결 링크"
              type="url"
              autoComplete="off"
              placeholder="연결 링크 붙여넣기"
              onChange={(e) => {
                try {
                  const url = new URL(e.target.value);
                  if (url.origin !== location.origin) throw new Error();
                  setPairCode(
                    new URLSearchParams(url.hash.slice(1)).get("pair") || "",
                  );
                  setError("");
                } catch {
                  setError("현재 PC의 Harbor 연결 링크를 붙여넣으세요.");
                }
              }}
            />
          </label>
          {pairCode && (
            <div className="card">
              <label>
                기기 이름
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void pair()}
              >
                이 기기 연결
              </button>
            </div>
          )}
          <p>
            Safari 공유 → 홈 화면에 추가하면 앱으로 사용할 수 있습니다. 홈 화면
            앱이 다시 등록을 요청하면 PC에서 새 연결 링크를 만드세요.
          </p>
          <button onClick={() => void refresh()}>연결 다시 확인</button>
        </main>
      ) : (
        <>
          <main className="page" hidden={tab !== "sessions"}>
            <div className="page-heading">
              <div>
                <h1>내 세션</h1>
                <p>진행 중인 작업을 이어가세요.</p>
              </div>
              <span className="count">{openTerminals.length}개</span>
            </div>
            <label className="session-search">
              <Search size={18} />
              <input
                aria-label="세션 검색"
                placeholder="세션 또는 서버 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button aria-label="검색 지우기" onClick={() => setQuery("")}>
                  <X size={16} />
                </button>
              )}
            </label>
            {state?.hosts.map((host) => (
              <section
                className="host-group"
                key={host.id}
                hidden={!matchingTerminals.some((t) => t.hostId === host.id)}
              >
                <h2>
                  {host.name}
                  <span>
                    {
                      matchingTerminals.filter((t) => t.hostId === host.id)
                        .length
                    }
                  </span>
                </h2>
                {matchingTerminals
                  .filter((t) => t.hostId === host.id)
                  .map((t) => (
                    <button
                      className={`session card ${selected === t.id ? "selected" : ""}`}
                      disabled={busy}
                      key={t.id}
                      onClick={() => choose(t.id)}
                      onPointerDown={() => prepare(t.id)}
                      onFocus={() => prepare(t.id)}
                    >
                      <span className="session-icon">
                        <TerminalIcon size={20} />
                      </span>
                      <span className="session-copy">
                        <strong>{t.title}</strong>
                        <small>
                          {t.agentKind === "claude"
                            ? "Claude"
                            : t.agentKind === "codex"
                              ? "Codex"
                              : "셸"}{" "}
                          · {sessionStatus(t)}
                        </small>
                        <span className="session-cwd">{t.cwd}</span>
                      </span>
                      {pending.some((r) => r.terminal.terminalId === t.id) ? (
                        <span
                          className="request-dot"
                          aria-label="대기 요청 있음"
                        />
                      ) : (
                        <span className="session-chevron">›</span>
                      )}
                    </button>
                  ))}
              </section>
            ))}
            {state && !openTerminals.length && (
              <div className="empty-state">
                <TerminalIcon size={30} />
                <h2>열린 세션이 없습니다</h2>
                <p>PC에서 터미널을 열면 여기에 표시됩니다.</p>
              </div>
            )}
            {query && !!openTerminals.length && !matchingTerminals.length && (
              <div className="empty-state">
                <Search size={28} />
                <p>검색 결과가 없습니다.</p>
              </div>
            )}
          </main>
          <div className="terminal-page" hidden={tab !== "terminal"}>
            <div className="terminal-toolbar">
              <span className="terminal-reading-hint">
                위로 올려 이전 내용 보기
              </span>
              <button
                className="type-button"
                aria-label="글자 크기 설정"
                aria-expanded={viewOptions}
                onClick={() => setViewOptions(!viewOptions)}
              >
                Aa
              </button>
              <button
                className="icon-button"
                aria-label="최신 내용으로 이동"
                onClick={() => viewportRef.current?.latest()}
              >
                <ArrowDown size={18} />
              </button>
            </div>
            {viewOptions && (
              <>
                <div className="type-options">
                  <span>글자 크기</span>
                  <button
                    aria-label="글자 작게"
                    onClick={() => setFont(Math.max(10, font - 1))}
                  >
                    A−
                  </button>
                  <output>{font}</output>
                  <button
                    aria-label="글자 크게"
                    onClick={() => setFont(Math.min(24, font + 1))}
                  >
                    A+
                  </button>
                  <button
                    aria-label="글자 크기 설정 닫기"
                    onClick={() => setViewOptions(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {terminal?.agentKind === "claude" && (
                  <label className="mods-view-option">
                    <input
                      type="checkbox"
                      checked={hideClaudeMods}
                      onChange={(event) =>
                        setHideClaudeMods(event.target.checked)
                      }
                    />
                    <span>
                      Mods 패널 숨기기
                      <small>
                        이 휴대폰에서만 적용 · 해제하면 전체 화면 표시
                      </small>
                    </span>
                  </label>
                )}
              </>
            )}
            {sharedControl && terminal && (
              <div className="control-banner" aria-label="세션 입력 제어">
                <span>
                  {control.otherOwner
                    ? `${control.otherOwner.deviceName}에서 입력 중 · 읽기 전용`
                    : control.owner
                      ? "이 기기에서 입력 중"
                      : "입력하면 이 기기에서 이어갑니다"}
                </span>
                {control.otherOwner && (
                  <button
                    disabled={!ready || busy || control.busy}
                    onClick={() => {
                      void control
                        .authorize(true)
                        .catch((e) => setError((e as Error).message));
                    }}
                  >
                    여기서 제어
                  </button>
                )}
              </div>
            )}
            {!!sessionRequests.length && (
              <details className="session-requests" key={selected}>
                <summary className="request-banner">
                  <Inbox size={16} />
                  <span>이 세션의 확인 요청 {sessionRequests.length}개</span>
                  <ChevronDown size={16} />
                </summary>
                <div className="request-list" aria-label="이 세션의 확인 요청">
                  {sessionRequests.map((r) => (
                    <RequestCard
                      key={r.id}
                      item={r}
                      enabled={!!inputEnabled}
                      authorize={() => control.authorize()}
                      done={() => void refresh()}
                    />
                  ))}
                </div>
              </details>
            )}
            {answerError && (
              <div className="answer-notice" role="status">
                <span>답변 조판을 불러오지 못했습니다.</span>
                <button onClick={() => setAnswerRevision((value) => value + 1)}>
                  다시 불러오기
                </button>
              </div>
            )}
            <div className="terminal-stage">
              <div
                className="terminal-scroll"
                ref={scrollRef}
                aria-label="터미널 출력"
                tabIndex={0}
              >
                <div className="terminal-host" ref={hostRef} />
                <MobileTerminalRich
                  key={`${selected}:${terminal?.agentSessionId || terminal?.resumeThreadId || ""}`}
                  onFlow={setTerminalFlow}
                  term={nativeTerminal}
                  blocks={currentAnswers}
                  active={tab === "terminal"}
                  updating={ready || preview}
                  following={following}
                  hideMods={terminal?.agentKind === "claude" && hideClaudeMods}
                  preserveModal={
                    terminal?.agentState === "waiting" ||
                    sessionRequests.length > 0
                  }
                  renderAnswer={(text) => <Markdown text={text} />}
                  renderHistory={(beforeTexts) => (
                    <MobileConversation
                      key={`${selected}:${terminal?.agentSessionId || terminal?.resumeThreadId || ""}`}
                      terminalId={selected}
                      sessionId={
                        terminal?.agentSessionId || terminal?.resumeThreadId
                      }
                      active={tab === "terminal"}
                      blocks={currentAnswers}
                      answerId=""
                      revision={answerRevision}
                      scroller={scrollRef}
                      following={terminalFollowRef}
                      embeddedBefore={beforeTexts}
                      renderText={(text) => <Markdown text={text} />}
                    />
                  )}
                />
              </div>
              {!following && (
                <button
                  className="jump-latest"
                  onClick={() => viewportRef.current?.latest()}
                >
                  <ArrowDown size={16} />
                  {unread ? "새 출력 · 맨 아래로" : "맨 아래로"}
                </button>
              )}
              {!selected && (
                <div className="no-terminal">
                  <TerminalIcon size={28} />
                  <p>이어갈 세션을 선택하세요.</p>
                  <button onClick={() => setTab("sessions")}>세션 목록</button>
                </div>
              )}
            </div>
            <div className="composer">
              <div className="keys" hidden={!keysOpen}>
                {[
                  "Escape",
                  "Tab",
                  "Ctrl+C",
                  "Up",
                  "Down",
                  "Left",
                  "Right",
                  "Enter",
                ].map((k) => (
                  <button
                    disabled={!inputEnabled}
                    key={k}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => void send(k)}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <div className="compose-row">
                <label
                  className={`file-button icon-button ${!inputEnabled ? "disabled" : ""}`}
                  title="사진·파일 첨부"
                >
                  <Paperclip size={21} />
                  <span className="sr-only">사진·파일</span>
                  <input
                    type="file"
                    aria-label="사진·파일 첨부"
                    disabled={!inputEnabled}
                    onChange={(e) => {
                      void attach(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <textarea
                  ref={inputRef}
                  rows={1}
                  aria-label="터미널에 보낼 입력"
                  value={draft}
                  onChange={(e) => {
                    if (!draft)
                      draftSessions.current.set(
                        selected,
                        terminal?.agentSessionId,
                      );
                    setDraft(e.target.value);
                  }}
                  placeholder={
                    terminal
                      ? "메시지 또는 명령 입력…"
                      : "세션을 먼저 선택하세요"
                  }
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  readOnly={busy}
                  disabled={!terminal}
                />
                <button
                  className="primary send-button"
                  aria-label="보내기 ↵"
                  disabled={!inputEnabled || !draft}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => void send()}
                >
                  <ArrowUp size={22} />
                </button>
              </div>
              <div className="composer-tools">
                <button
                  aria-expanded={keysOpen}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => setKeysOpen(!keysOpen)}
                >
                  <Keyboard size={16} />
                  {keysOpen ? "특수키 접기" : "특수키"}
                </button>
                {draft ? (
                  <button
                    disabled={!inputEnabled}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => void send(undefined, false)}
                  >
                    입력만 붙여넣기
                  </button>
                ) : (
                  <span>
                    {busy
                      ? "처리 중…"
                      : !ready
                        ? "연결 확인 중"
                        : "Enter는 줄바꿈 · ↑로 전송"}
                  </span>
                )}
                {keyboardOpen && (
                  <button onClick={() => inputRef.current?.blur()}>
                    키보드 닫기
                  </button>
                )}
              </div>
            </div>
          </div>
          <main className="page" hidden={tab !== "settings"}>
            <h1>기기 설정</h1>
            <article className="card">
              <h2>홈 화면에 추가</h2>
              <p>
                Safari 공유 메뉴 → 홈 화면에 추가. 홈 화면 앱에서 다시 연결이
                필요하면 PC에서 링크를 새로 만드세요.
              </p>
            </article>
            <MobileNotifications active={tab === "settings"} api={api} />
            <button
              onClick={() => {
                void api("/logout", {})
                  .then(() => {
                    setPaired(false);
                    setState(undefined);
                    drafts.current.clear();
                    setDraft("");
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              이 기기 연결 해제
            </button>
          </main>
          <nav aria-label="모바일 메뉴">
            {(
              [
                ["sessions", "세션"],
                ["terminal", "터미널"],
                ["settings", "설정"],
              ] as const
            ).map(([id, label]) => {
              const Icon = {
                sessions: Layers,
                terminal: TerminalIcon,
                settings: Settings,
              }[id];
              return (
                <button
                  key={id}
                  aria-label={label}
                  aria-current={tab === id ? "page" : undefined}
                  disabled={busy}
                  onClick={() => {
                    inputRef.current?.blur();
                    setTab(id);
                  }}
                >
                  <Icon size={20} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
