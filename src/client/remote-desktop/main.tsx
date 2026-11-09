import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { MobileState } from "../../shared/mobile";
import type { TerminalInfo } from "../../shared/types";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import { createIdeApi, type IdeSelection } from "../ide/types";
import { restoreTerminalReplay, writeTerminal } from "../terminalReplay";
import { isTerminalProtocolResponse } from "../../shared/terminal-protocol-response";
import type { IdeChatRequest } from "../ide/IdeChatPanel";
import "@xterm/xterm/css/xterm.css";
import "./remote.css";
import "../ide/layout.css";
const IdeWorkspace = lazy(() => import("../ide/IdeWorkspace"));
const IdeChatPanel = lazy(() => import("../ide/IdeChatPanel"));
const RemoteRich = lazy(() => import("./RemoteRich"));
const RemoteMarkdown = lazy(() =>
  import("./RemoteRich").then((module) => ({ default: module.RemoteMarkdown })),
);
const clientId = crypto.randomUUID();
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Harbor-Mobile": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error || "연결 요청을 완료하지 못했습니다."),
      { status: response.status },
    );
  return result;
}
function App() {
  const [state, setState] = useState<MobileState>(),
    [selected, setSelected] = useState(""),
    [ideHost, setIdeHost] = useState(""),
    [connected, setConnected] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [needsPair, setNeedsPair] = useState(false),
    [name, setName] = useState("내 PC"),
    [code, setCode] = useState(
      () => new URLSearchParams(location.hash.slice(1)).get("pair") || "",
    ),
    [mode, setMode] = useState<"terminal" | "ide">("terminal"),
    [loadedIde, setLoadedIde] = useState(false),
    [terminalOpen, setTerminalOpen] = useState(false),
    [chatOpen, setChatOpen] = useState(true),
    [editorHeight, setEditorHeight] = useState(72),
    [chatWidth, setChatWidth] = useState(32),
    [quote, setQuote] = useState<{ id: string; selection: IdeSelection }>();
  const [blocks, setBlocks] = useState<RichTerminalBlock[]>([]);
  const workspaceRef = useRef<HTMLDivElement>(null),
    editorRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null),
    term = useRef<Terminal | undefined>(undefined),
    fit = useRef<FitAddon | undefined>(undefined),
    socket = useRef<WebSocket | undefined>(undefined),
    subscription = useRef(""),
    current = useRef({ state, selected, ready, connected }),
    lease = useRef<
      | { id: string; token: string; runtime: string; session?: string }
      | undefined
    >(undefined),
    pendingInput = useRef<
      { id: string; runtime: string; session?: string; data: string }[]
    >([]),
    flushing = useRef(false),
    inputTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    lastResize = useRef("");
  current.current = { state, selected, ready, connected };
  const active = state?.terminals.find((t) => t.id === selected),
    control = state?.controls?.[selected],
    mine = control?.clientId === clientId;
  const ideHostId =
    (state?.hosts.some((host) => host.id === ideHost) ? ideHost : "") ||
    active?.hostId ||
    state?.hosts[0]?.id ||
    "";
  const ideTerminal = active?.hostId === ideHostId ? active : undefined;
  const identity = (t: TerminalInfo, s: MobileState) => ({
    runtimeId: s.runtimeId,
    sessionId: t.agentSessionId,
  });
  async function claim(takeover = false) {
    const { state: s, selected: id, ready: r, connected: c } = current.current,
      t = s?.terminals.find((t) => t.id === id);
    if (!s || !t || !r || !c)
      throw new Error("터미널 화면 연결을 기다려주세요.");
    const owner = s.controls?.[id];
    if (
      owner &&
      owner.clientId !== clientId &&
      owner.expiresAt > Date.now() &&
      !takeover
    )
      throw new Error(
        `${owner.deviceName}에서 제어 중입니다. ‘여기서 제어’를 누르세요.`,
      );
    if (
      !takeover &&
      lease.current?.id === id &&
      lease.current.runtime === s.runtimeId &&
      lease.current.session === t.agentSessionId &&
      owner?.clientId === clientId &&
      owner.expiresAt > Date.now() + 1000
    )
      return lease.current.token;
    const result = await request(`/mobile-api/terminals/${id}/control`, {
      ...identity(t, s),
      clientId,
      action: "claim",
      takeover,
    });
    if (
      current.current.selected !== id ||
      current.current.state?.runtimeId !== s.runtimeId ||
      current.current.state?.terminals.find((item) => item.id === id)
        ?.agentSessionId !== t.agentSessionId
    ) {
      void request(`/mobile-api/terminals/${id}/control`, {
        ...identity(t, s),
        clientId,
        action: "release",
      }).catch(() => {});
      throw new Error("선택한 세션이 바뀌었습니다.");
    }
    lease.current = {
      id,
      token: result.token,
      runtime: s.runtimeId,
      session: t.agentSessionId,
    };
    setState((prev) =>
      prev
        ? { ...prev, controls: { ...prev.controls, [id]: result.control } }
        : prev,
    );
    return result.token as string;
  }
  async function input(raw: string, id = current.current.selected) {
    const s = current.current.state,
      t = s?.terminals.find((t) => t.id === id);
    if (!s || !t || id !== current.current.selected) return;
    const token = await claim();
    if (id !== current.current.selected)
      throw new Error("세션이 바뀌어 입력을 보내지 않았습니다.");
    await request("/mobile-api/input", {
      ...identity(t, s),
      requestId: crypto.randomUUID(),
      terminalId: id,
      clientId,
      controlToken: token,
      raw,
    });
  }
  function enqueue(data: string) {
    const { selected: id, state: s, ready: r } = current.current,
      t = s?.terminals.find((t) => t.id === id);
    if (!s || !t || !r) return;
    // Device/cursor replies are produced by xterm during rendering, not typing.
    // Spectators must never acquire control because the CLI queried its screen.
    if (isTerminalProtocolResponse(data)) {
      const owner = s.controls?.[id],
        held = lease.current;
      if (
        !held ||
        held.id !== id ||
        held.runtime !== s.runtimeId ||
        held.session !== t.agentSessionId ||
        owner?.clientId !== clientId ||
        owner.expiresAt <= Date.now()
      )
        return;
    }
    if (
      pendingInput.current.reduce((n, item) => n + item.data.length, 0) +
        data.length >
      64000
    ) {
      setError("전송 대기 입력이 많습니다. 잠시 기다린 뒤 다시 입력하세요.");
      return;
    }
    for (let offset = 0; offset < data.length; offset += 16000) {
      const part = data.slice(offset, offset + 16000),
        last = pendingInput.current.at(-1);
      if (
        last &&
        last.id === id &&
        last.runtime === s.runtimeId &&
        last.session === t.agentSessionId &&
        last.data.length + part.length <= 16000
      )
        last.data += part;
      else
        pendingInput.current.push({
          id,
          runtime: s.runtimeId,
          session: t.agentSessionId,
          data: part,
        });
    }
    if (!flushing.current && !inputTimer.current)
      inputTimer.current = setTimeout(() => {
        inputTimer.current = undefined;
        void flushInput();
      }, 12);
  }
  async function flushInput() {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (pendingInput.current.length) {
        const next = pendingInput.current.shift()!,
          s = current.current.state,
          t = s?.terminals.find((t) => t.id === next.id);
        if (
          !s ||
          !t ||
          current.current.selected !== next.id ||
          s.runtimeId !== next.runtime ||
          t.agentSessionId !== next.session
        )
          continue;
        try {
          await input(next.data, next.id);
        } catch (e) {
          pendingInput.current = pendingInput.current.filter(
            (item) =>
              item.id !== next.id ||
              item.runtime !== next.runtime ||
              item.session !== next.session,
          );
          setError(
            `${(e as Error).message} 전송이 불확실한 입력은 자동으로 다시 보내지 않습니다.`,
          );
        }
      }
    } finally {
      flushing.current = false;
    }
  }
  useEffect(() => {
    history.replaceState(null, "", location.pathname);
  }, []);
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      scrollback: 15000,
      theme: {
        background: "#ffffff",
        foreground: "#202634",
        selectionBackground: "#abc8ff",
      },
      allowProposedApi: false,
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.loadAddon(
      new WebLinksAddon((_event, url) => {
        if (/^https?:\/\//i.test(url))
          window.open(url, "_blank", "noopener,noreferrer");
      }),
    );
    terminal.open(host.current!);
    term.current = terminal;
    fit.current = addon;
    const subscription = terminal.onData(enqueue);
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c" &&
        terminal.hasSelection()
      ) {
        void navigator.clipboard
          .writeText(terminal.getSelection())
          .catch(() =>
            setError("선택한 텍스트를 브라우저의 복사 메뉴로 복사하세요."),
          );
        return false;
      }
      return true;
    });
    return () => {
      clearTimeout(inputTimer.current);
      pendingInput.current = [];
      subscription.dispose();
      terminal.dispose();
    };
  }, []);
  useEffect(() => {
    if (needsPair) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    let outputQueue = Promise.resolve(),
      queuedBytes = 0;
    function connect() {
      if (stopped) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/mobile-ws`,
      );
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setError("");
      };
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (stopped || socket.current !== ws) return;
        if (message.type === "state") {
          const next = message.state as MobileState;
          if (next.viewer?.kind !== "desktop") {
            setNeedsPair(true);
            setError("호스트 PC에서 PC용 연결 링크를 만들어 등록하세요.");
            ws.close();
            return;
          }
          setNeedsPair(false);
          setState(next);
          setSelected((id) =>
            next.terminals.some((t) => t.id === id)
              ? id
              : next.terminals[0]?.id || "",
          );
          return;
        }
        if (message.subscriptionId !== subscription.current) return;
        if (["snapshot", "data", "resize"].includes(message.type)) {
          const size = message.data?.length || 0;
          queuedBytes += size;
          if (queuedBytes > 8 * 1024 * 1024) {
            ws.close(1013, "Replay overflow");
            return;
          }
          const valid = () =>
            !stopped &&
            socket.current === ws &&
            message.subscriptionId === subscription.current;
          outputQueue = outputQueue
            .then(async () => {
              if (!valid() || !term.current) return;
              const terminal = term.current;
              if (message.type === "snapshot") {
                const restored = await restoreTerminalReplay(
                  terminal,
                  message.data,
                  message.replay,
                  valid,
                );
                if (restored) {
                  terminal.scrollToBottom();
                  setReady(true);
                }
              } else if (message.type === "data")
                await writeTerminal(terminal, message.data);
              else terminal.resize(message.cols, message.rows);
            })
            .catch((e) => {
              if (valid()) {
                setError(e.message);
                setReady(false);
                ws.close();
              }
            })
            .finally(() => {
              queuedBytes -= size;
            });
        } else if (message.type === "error") {
          setError(message.error);
          setReady(false);
        }
      };
      ws.onclose = (event) => {
        if (stopped) return;
        setConnected(false);
        setReady(false);
        lease.current = undefined;
        if (event.code === 4001) {
          setNeedsPair(true);
          return;
        }
        timer = setTimeout(connect, 2500);
      };
      ws.onerror = () => {
        void request("/mobile-api/state").catch((e) => {
          if (e.status === 401) setNeedsPair(true);
        });
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, [needsPair]);
  useEffect(() => {
    setReady(false);
    lease.current = undefined;
    pendingInput.current = [];
    lastResize.current = "";
    setQuote(undefined);
    if (
      !selected ||
      !connected ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return;
    const sub = crypto.randomUUID();
    subscription.current = sub;
    term.current?.reset();
    socket.current.send(
      JSON.stringify({ type: "subscribe", id: selected, subscriptionId: sub }),
    );
    return () => {
      const l = lease.current;
      if (l?.id === selected) {
        lease.current = undefined;
        void request(`/mobile-api/terminals/${selected}/control`, {
          clientId,
          runtimeId: l.runtime,
          sessionId: l.session,
          action: "release",
        }).catch(() => {});
      }
    };
  }, [selected, connected, state?.runtimeId, active?.agentSessionId]);
  useEffect(() => {
    if (!mine || !selected || !ready) return;
    const timer = setInterval(() => {
      const s = current.current.state,
        t = s?.terminals.find((t) => t.id === selected);
      if (!s || !t || document.hidden) return;
      void request(`/mobile-api/terminals/${selected}/control`, {
        ...identity(t, s),
        clientId,
        action: "renew",
      }).catch((e) => {
        lease.current = undefined;
        setError(e.message);
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [mine, selected, ready]);
  useEffect(() => {
    if (!host.current || !mine || !ready || (mode === "ide" && !terminalOpen))
      return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dims = fit.current?.proposeDimensions(),
          s = current.current.state,
          t = s?.terminals.find((t) => t.id === selected),
          l = lease.current;
        if (!dims || !s || !t || !l || l.id !== selected) return;
        const cols = Math.max(10, Math.min(500, dims.cols)),
          rows = Math.max(3, Math.min(200, dims.rows)),
          key = `${selected}:${cols}:${rows}`;
        if (key === lastResize.current) return;
        lastResize.current = key;
        void request(`/desktop-api/terminals/${selected}/resize`, {
          ...identity(t, s),
          clientId,
          controlToken: l.token,
          cols,
          rows,
        }).catch((e) => {
          lastResize.current = "";
          setError(e.message);
        });
      }, 200);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [mine, selected, ready, mode, terminalOpen]);
  const chatRequest = useMemo<IdeChatRequest>(
    () => async (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("X-Harbor-Mobile", "1");
      headers.set("X-Harbor-Client", clientId);
      const liveId = headers.get("X-Harbor-Terminal");
      if (init?.method === "POST" && liveId) {
        const before = current.current.state;
        const terminal = before?.terminals.find((item) => item.id === liveId);
        if (!before || !terminal || terminal.exited)
          throw new Error(
            "연결된 터미널을 찾을 수 없습니다. 현재 대화를 다시 선택하세요.",
          );
        const result = await request(
          `/mobile-api/terminals/${encodeURIComponent(liveId)}/control`,
          {
            ...identity(terminal, before),
            clientId,
            action: "claim",
          },
        );
        const latest = current.current.state;
        const currentTerminal = latest?.terminals.find(
          (item) => item.id === liveId,
        );
        if (
          latest?.runtimeId !== before.runtimeId ||
          currentTerminal?.hostId !== terminal.hostId ||
          currentTerminal?.agentSessionId !== terminal.agentSessionId
        )
          throw new Error("대화가 변경되어 메시지를 보내지 않았습니다.");
        headers.set("X-Harbor-Control", result.token);
      }
      return fetch(`/desktop-api/ide-chat${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      });
    },
    [],
  );
  const ideApi = useMemo(
    () =>
      createIdeApi(async (path, init) => {
        let token: string | undefined;
        if (init.method === "PUT") {
          const id = path.split("/")[3];
          if (decodeURIComponent(id || "") !== current.current.selected)
            throw new Error("이 파일을 연 터미널을 다시 선택한 뒤 저장하세요.");
          token = await claim();
        }
        return fetch(path, {
          ...init,
          credentials: "same-origin",
          headers: {
            ...init.headers,
            "X-Harbor-Mobile": "1",
            "X-Harbor-Client": clientId,
            ...(token ? { "X-Harbor-Control": token } : {}),
          },
          signal: AbortSignal.timeout(30_000),
        });
      }, "/desktop-api/editor"),
    [],
  );
  useEffect(() => {
    setBlocks([]);
    if (!selected || !connected) return;
    let live = true,
      pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await request(`/mobile-api/terminals/${selected}/answers`);
        if (live) setBlocks(next);
      } catch {
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, connected, active?.agentSessionId]);
  async function pair() {
    try {
      await request("/mobile-api/pair", { code, name });
      setCode("");
      setNeedsPair(false);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className={`remote-app ${mode === "ide" ? "remote-ide-mode" : ""}`}>
      <aside hidden={mode === "ide"}>
        <h1>
          Harbor <small>PC 연결</small>
        </h1>
        <p className="remote-host">{location.host}</p>
        <nav aria-label="열린 세션">
          {state?.terminals.map((t) => (
            <button
              key={t.id}
              className={selected === t.id ? "selected" : ""}
              onClick={() => {
                setError("");
                setSelected(t.id);
                setIdeHost(t.hostId);
              }}
            >
              <b>{t.title}</b>
              <small>
                {state.hosts.find((h) => h.id === t.hostId)?.name} ·{" "}
                {t.agentKind || "셸"}
              </small>
            </button>
          ))}
        </nav>
        <p>호스트 PC의 실행 중인 세션을 공유합니다.</p>
        <button
          onClick={() => {
            if (
              loadedIde &&
              !window.confirm(
                "연결을 해제하면 이 창의 편집 내용이 닫힙니다. 파일을 저장했는지 확인하세요.",
              )
            )
              return;
            void request("/mobile-api/logout", {}).then(() => {
              setLoadedIde(false);
              setState(undefined);
              setNeedsPair(true);
            });
          }}
        >
          이 PC 연결 해제
        </button>
      </aside>
      <main>
        <header>
          {mode === "ide" ? (
            <label className="remote-ide-session">
              <b>Harbor IDE</b>
              <select
                aria-label="IDE 서버"
                value={ideHostId}
                onChange={(event) => {
                  const id = event.target.value;
                  setIdeHost(id);
                  setQuote(undefined);
                  const terminal = state?.terminals.find(
                    (item) => item.hostId === id,
                  );
                  if (terminal) setSelected(terminal.id);
                  else setTerminalOpen(false);
                }}
              >
                {state?.hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="IDE 세션"
                value={ideTerminal?.id || ""}
                disabled={
                  !state?.terminals.some((item) => item.hostId === ideHostId)
                }
                onChange={(event) => {
                  setError("");
                  setSelected(event.target.value);
                }}
              >
                {!ideTerminal && <option value="">열린 터미널 없음</option>}
                {state?.terminals
                  .filter((item) => item.hostId === ideHostId)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {
                        state.hosts.find((host) => host.id === item.hostId)
                          ?.name
                      }{" "}
                      · {item.title}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <strong>{active?.title || "열린 세션"}</strong>
          )}
          <span role="status">
            {connected
              ? ready || (mode === "ide" && !ideTerminal)
                ? "연결됨"
                : "화면 연결 중…"
              : "연결 중…"}
          </span>
          <button
            aria-pressed={mode === "terminal"}
            onClick={() => setMode("terminal")}
          >
            터미널
          </button>
          <button
            aria-pressed={mode === "ide"}
            disabled={!state?.hosts.length}
            onClick={() => {
              setLoadedIde(true);
              setMode("ide");
            }}
          >
            IDE
          </button>
          <button
            disabled={!ready}
            onClick={() =>
              void claim(true)
                .then(() => {
                  setError("");
                  if (mode !== "ide" || terminalOpen) term.current?.focus();
                })
                .catch((e) => setError(e.message))
            }
          >
            {mine ? "이 PC에서 제어 중" : "여기서 제어"}
          </button>
          {mode === "ide" && (
            <>
              <button
                aria-label={
                  terminalOpen ? "터미널 패널 접기" : "터미널 패널 열기"
                }
                aria-pressed={terminalOpen}
                onClick={() => setTerminalOpen((value) => !value)}
              >
                터미널 패널
              </button>
              <button
                aria-label={
                  chatOpen ? "AI 채팅 패널 접기" : "AI 채팅 패널 열기"
                }
                aria-pressed={chatOpen}
                onClick={() => setChatOpen((value) => !value)}
              >
                AI 채팅
              </button>
            </>
          )}
        </header>
        {control && !mine && (
          <div className="remote-notice">
            {control.deviceName}에서 제어 중 · 읽기 전용
          </div>
        )}
        {error && (
          <div role="alert" className="remote-error">
            {error}
            <button onClick={() => setError("")}>닫기</button>
          </div>
        )}
        <div
          ref={workspaceRef}
          className={`remote-workspace ${mode === "ide" ? "with-ide" : ""}`}
        >
          <div
            ref={editorRef}
            className="remote-editor desktop-ide-workspace"
            hidden={mode !== "ide"}
            style={
              mode === "ide" && terminalOpen
                ? { flex: `0 0 ${editorHeight}%` }
                : undefined
            }
          >
            {loadedIde && (
              <Suspense fallback={<p>편집기 불러오는 중…</p>}>
                <IdeWorkspace
                  api={ideApi}
                  terminalId={ideTerminal?.id || ""}
                  hostId={ideHostId}
                  workspaceCwd={ideTerminal?.cwd}
                  hostLabel={state?.hosts.find((h) => h.id === ideHostId)?.name}
                  visible={mode === "ide"}
                  renderMarkdown={(text, _file, actions) => (
                    <RemoteMarkdown
                      text={text}
                      onFileLink={actions.openFile}
                      onAnchor={actions.openAnchor}
                    />
                  )}
                  onQuote={async (selection) => {
                    if (selection.terminalId !== current.current.selected)
                      throw new Error(
                        "이 파일을 연 터미널을 다시 선택한 뒤 인용하세요.",
                      );
                    setQuote({ id: crypto.randomUUID(), selection });
                    setChatOpen(true);
                  }}
                />
              </Suspense>
            )}
            {loadedIde && (
              <>
                {chatOpen && (
                  <div
                    className="harbor-ide-chat-divider"
                    role="separator"
                    aria-label="편집기와 AI 채팅 너비 조절"
                    aria-orientation="vertical"
                    aria-valuemin={24}
                    aria-valuemax={48}
                    aria-valuenow={Math.round(chatWidth)}
                    tabIndex={0}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (
                        !event.currentTarget.hasPointerCapture(event.pointerId)
                      )
                        return;
                      const bounds = editorRef.current?.getBoundingClientRect();
                      if (bounds?.width)
                        setChatWidth(
                          Math.max(
                            24,
                            Math.min(
                              48,
                              ((bounds.right - event.clientX) / bounds.width) *
                                100,
                            ),
                          ),
                        );
                    }}
                    onPointerUp={(event) => {
                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      )
                        event.currentTarget.releasePointerCapture(
                          event.pointerId,
                        );
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight"
                      ) {
                        event.preventDefault();
                        setChatWidth((width) =>
                          Math.max(
                            24,
                            Math.min(
                              48,
                              width + (event.key === "ArrowLeft" ? 2 : -2),
                            ),
                          ),
                        );
                      }
                    }}
                  />
                )}
                <aside
                  className="harbor-ide-chat-region"
                  aria-label="AI 채팅"
                  hidden={!chatOpen}
                  style={{ width: `${chatWidth}%` }}
                >
                  <Suspense fallback={<p>AI 채팅 불러오는 중…</p>}>
                    <IdeChatPanel
                      terminal={ideTerminal}
                      hostId={ideHostId}
                      attachment={quote}
                      onAttachmentConsumed={(id) =>
                        setQuote((current) =>
                          current?.id === id ? undefined : current,
                        )
                      }
                      hostName={
                        state?.hosts.find((item) => item.id === ideHostId)?.name
                      }
                      active={mode === "ide" && chatOpen && connected}
                      onFocusTerminal={(id) => {
                        const target = current.current.state?.terminals.find(
                          (item) => item.id === id,
                        );
                        if (!target) return;
                        setSelected(id);
                        setIdeHost(target.hostId);
                        requestAnimationFrame(() => term.current?.focus());
                      }}
                      onShowTerminal={() => setTerminalOpen(true)}
                      request={chatRequest}
                      renderMarkdown={(text) => (
                        <Suspense fallback={<pre>{text}</pre>}>
                          <RemoteMarkdown text={text} />
                        </Suspense>
                      )}
                    />
                  </Suspense>
                </aside>
              </>
            )}
          </div>
          {mode === "ide" && terminalOpen && (
            <div
              className="harbor-ide-divider"
              role="separator"
              aria-label="편집기와 터미널 크기 조절"
              aria-orientation="horizontal"
              aria-valuemin={35}
              aria-valuemax={85}
              aria-valuenow={Math.round(editorHeight)}
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId))
                  return;
                const bounds = workspaceRef.current?.getBoundingClientRect();
                if (bounds?.height)
                  setEditorHeight(
                    Math.max(
                      35,
                      Math.min(
                        85,
                        ((event.clientY - bounds.top) / bounds.height) * 100,
                      ),
                    ),
                  );
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  setEditorHeight((height) =>
                    Math.max(
                      35,
                      Math.min(85, height + (event.key === "ArrowUp" ? -5 : 5)),
                    ),
                  );
                }
              }}
            />
          )}
          {mode === "ide" && (
            <div className="remote-dock-heading">
              <button
                aria-expanded={terminalOpen}
                aria-controls="remote-terminal-dock"
                onClick={() => setTerminalOpen((value) => !value)}
              >
                터미널 {terminalOpen ? "⌄" : "⌃"}
              </button>
              <span>{active?.title}</span>
            </div>
          )}
          <section
            id="remote-terminal-dock"
            className="remote-terminal"
            aria-label="공유 터미널"
            hidden={mode === "ide" && !terminalOpen}
          >
            <div ref={host} className="remote-xterm" />
            {ready && (
              <Suspense fallback={null}>
                <RemoteRich
                  term={term.current}
                  blocks={blocks}
                  sessionId={active?.agentSessionId}
                />
              </Suspense>
            )}
            {!active && (
              <p className="remote-empty">
                호스트 PC에서 터미널을 열면 여기에 표시됩니다.
              </p>
            )}
          </section>
        </div>
      </main>
      {(needsPair || code) && (
        <div className="remote-overlay">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void pair();
            }}
          >
            <h2>이 PC 연결</h2>
            <p>호스트 PC에서 만든 PC용 일회용 링크로 등록합니다.</p>
            <label>
              기기 이름
              <input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              연결 코드
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button disabled={!code || !name.trim()}>등록하고 세션 보기</button>
            {error && <p role="alert">{error}</p>}
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
