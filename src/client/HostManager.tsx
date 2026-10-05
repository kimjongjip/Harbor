import { useState, type CSSProperties } from "react";
import {
  ArrowRight,
  Check,
  Globe2,
  GripVertical,
  HardDrive,
  LoaderCircle,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { HostView, TerminalInfo } from "../shared/types";
import { api } from "./api";
import { useTheme, terminalColors } from "./Theme";
import { useHostReorderDrag, type MoveHost } from "./server-order";
import "./server-order.css";

interface Props {
  hosts: HostView[];
  selectedId?: string;
  editorId: string | null;
  setEditorId: (id: string | null) => void;
  onSelect: (id: string) => void;
  onConnect: (host: HostView) => void;
  onCreated: (terminal: TerminalInfo) => void;
  ready: boolean;
  opening: string;
  credentialStorageAvailable: boolean;
  query: string;
  setQuery: (value: string) => void;
  onMoveHost?: MoveHost;
  onMoveHostBy?: (id: string, direction: -1 | 1) => void;
}
export default function HostManager(props: Props) {
  const { hosts, editorId, setEditorId, query, setQuery } = props;
  const drag = useHostReorderDrag(props.onMoveHost);
  const filtered = hosts.filter((h) =>
    `${h.name} ${h.address} ${h.username}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="host-library" aria-label="서버 관리">
      <div className="host-library-main">
        <header className="host-library-heading">
          <div>
            <span className="harbor-eyebrow">YOUR WORKSPACE</span>
            <h1>내 서버</h1>
            <p>연결할 서버를 선택하세요. 터미널에서 바로 작업을 시작합니다.</p>
          </div>
          <button
            className="button primary"
            disabled={!props.ready}
            onClick={() => setEditorId("new")}
          >
            <Plus size={16} />
            서버 추가
          </button>
        </header>
        <div className="host-search">
          <Search size={17} />
          <input
            aria-label="서버 검색"
            placeholder="이름, 주소로 서버 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span>{hosts.length}개</span>
        </div>
        <div className="host-cards">
          {filtered.map((host) => (
            <article
              key={host.id}
              className={`host-profile-card ${props.selectedId === host.id ? "selected" : ""} ${drag.draggingId === host.id ? "is-dragging" : ""}`}
              data-host-id={host.id}
              data-drop-position={drag.dropPosition(host.id)}
              {...drag.dragProps(host.id)}
              onClick={() => props.onSelect(host.id)}
              onDoubleClick={() => props.onConnect(host)}
            >
              <div className="host-card-top">
                <span
                  className={`host-avatar ${host.kind}`}
                  style={{ "--host-color": host.color } as CSSProperties}
                >
                  {host.kind === "local" ? (
                    <HardDrive size={24} />
                  ) : (
                    <Globe2 size={24} />
                  )}
                </span>
                {props.onMoveHost && (
                  <button
                    className="host-reorder-grip"
                    draggable
                    aria-label={`${host.name} 순서 이동`}
                    title="드래그로 순서 이동 · Alt+↑/↓"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (
                        event.altKey &&
                        ["ArrowUp", "ArrowDown"].includes(event.key) &&
                        props.onMoveHostBy
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onMoveHostBy(
                          host.id,
                          event.key === "ArrowUp" ? -1 : 1,
                        );
                      }
                    }}
                  >
                    <GripVertical size={16} />
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label={`${host.name} 설정`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onSelect(host.id);
                    setEditorId(host.id);
                  }}
                >
                  <Settings2 size={17} />
                </button>
              </div>
              <h2>{host.name}</h2>
              <p className="host-card-address">
                {host.kind === "local"
                  ? "이 컴퓨터"
                  : `${host.username ? `${host.username}@` : ""}${host.address}:${host.port}`}
              </p>
              <div className="host-card-meta">
                <span>
                  {host.terminalConnected ? (
                    <>
                      <i className="harbor-online" />
                      연결됨
                    </>
                  ) : host.kind === "ssh" ? (
                    "SSH"
                  ) : (
                    "LOCAL"
                  )}
                </span>
                {host.hasSavedPassword && (
                  <span title="이 Windows 계정으로 암호화한 비밀번호">
                    <ShieldCheck size={13} />
                    로그인 저장됨
                  </span>
                )}
              </div>
              <button
                className="host-card-connect"
                disabled={!!props.opening}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onConnect(host);
                }}
              >
                {props.opening === host.id ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Terminal size={16} />
                )}
                <span>{props.opening === host.id ? "연결 중…" : "연결"}</span>
                <ArrowRight size={16} />
              </button>
            </article>
          ))}
        </div>
        {!filtered.length && (
          <p className="host-no-results">일치하는 서버가 없습니다.</p>
        )}
        <div className="host-library-tip">
          <Terminal size={20} />
          <div>
            <b>터미널 하나에서, 필요한 도구 그대로.</b>
            <p>
              <code>codex</code>를 실행하면 이 세션에 연결됩니다. 터미널 이름을
              정하고 다른 세션과 메시지를 주고받으세요.
            </p>
          </div>
        </div>
      </div>
      {editorId && (
        <HostEditor
          key={editorId}
          host={hosts.find((h) => h.id === editorId)}
          available={props.credentialStorageAvailable}
          onClose={() => setEditorId(null)}
          onSaved={(id) => {
            setEditorId(null);
            props.onSelect(id);
          }}
          onCreated={props.onCreated}
        />
      )}
    </section>
  );
}

function HostEditor({
  host,
  available,
  onClose,
  onSaved,
  onCreated,
}: {
  host?: HostView;
  available: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
  onCreated: (terminal: TerminalInfo) => void;
}) {
  const { theme } = useTheme();
  const [name, setName] = useState(host?.name || "");
  const [address, setAddress] = useState(host?.address || "");
  const [port, setPort] = useState(host?.port || 22);
  const [username, setUsername] = useState(host?.username || "");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(available);
  const [cwd, setCwd] = useState(host?.defaultCwd || "");
  const [codexPath, setCodexPath] = useState(host?.codexPath || "codex");
  const [identityFile, setIdentityFile] = useState(host?.identityFile || "");
  const [hasSaved, setHasSaved] = useState(!!host?.hasSavedPassword);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedId, setSavedId] = useState(host?.id);
  const local = host?.kind === "local";
  const input = {
    name,
    kind: local ? "local" : "ssh",
    address,
    port,
    username,
    defaultCwd: cwd,
    codexPath,
    identityFile,
    mode: host?.mode || "auto",
    color: host?.color || "#719ce0",
  };
  const changed =
    !host ||
    Object.entries(input).some(
      ([key, value]) => value !== host[key as keyof HostView],
    );
  async function save() {
    if (!name.trim() || (!local && !address.trim()))
      throw new Error("서버 이름과 주소를 입력하세요.");
    const saved =
      changed || !savedId
        ? await api<HostView>(
            savedId ? `/hosts/${savedId}` : "/hosts",
            input,
            savedId ? "PATCH" : "POST",
          )
        : host!;
    const id = saved.id;
    setSavedId(id);
    setHasSaved(!!saved.hasSavedPassword);
    if (password && savePassword && available) {
      await api(`/hosts/${id}/credentials`, { password });
      setHasSaved(true);
    }
    return id;
  }
  async function action(mode: "save" | "test" | "connect") {
    setBusy(mode);
    setError("");
    setNotice("");
    try {
      const id = await save();
      if (mode === "test") {
        await api(`/hosts/${id}/test-connection`, {
          password: password || undefined,
          savePassword: savePassword && available,
        });
        setNotice("SSH 연결을 확인했습니다.");
      }
      if (mode === "connect") {
        onCreated(
          await api<TerminalInfo>("/terminals", {
            hostId: id,
            cwd,
            program: "shell",
            colors: terminalColors(theme),
            password: password || undefined,
            savePassword: savePassword && available,
          }),
        );
      }
      if (mode === "save") {
        setNotice("서버 설정을 저장했습니다.");
        setPassword("");
        onSaved(id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <aside className="host-editor" aria-label="서버 설정">
      <header>
        <h2>{host ? "서버 설정" : "새 SSH 서버"}</h2>
        <button
          className="icon-button"
          aria-label="서버 설정 닫기"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action("connect");
        }}
      >
        <div className="host-editor-scroll">
          <section>
            <label className="field">
              이름
              <input
                aria-label="서버 이름"
                required
                placeholder="예: build-server"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {!local && (
              <label className="field">
                주소
                <input
                  aria-label="서버 주소"
                  required
                  placeholder="IP 주소 또는 SSH 별칭"
                  autoComplete="off"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </label>
            )}
          </section>
          {!local && (
            <section>
              <h3>SSH 연결</h3>
              <div className="host-auth-row">
                <label className="field">
                  사용자
                  <input
                    aria-label="SSH 사용자"
                    value={username}
                    autoComplete="off"
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label className="field">
                  포트
                  <input
                    aria-label="SSH 포트"
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="field">
                비밀번호
                <input
                  aria-label="SSH 비밀번호"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    hasSaved ? "저장된 비밀번호 사용" : "키 인증은 비워두세요"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {available && (
                <label className="host-check">
                  <input
                    type="checkbox"
                    checked={savePassword}
                    onChange={(e) => setSavePassword(e.target.checked)}
                  />
                  이 컴퓨터에 로그인 저장
                </label>
              )}
              <small className="host-storage-note">
                <ShieldCheck size={13} />
                {available
                  ? "비밀번호는 Windows 계정으로 암호화됩니다."
                  : "비밀번호는 현재 실행 중에만 사용합니다."}
              </small>
              {hasSaved && (
                <button
                  type="button"
                  className="host-forget"
                  disabled={!!busy}
                  onClick={async () => {
                    try {
                      await api(
                        `/hosts/${savedId}/credentials`,
                        undefined,
                        "DELETE",
                      );
                      setHasSaved(false);
                      setNotice("저장된 비밀번호를 지웠습니다.");
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  저장된 비밀번호 지우기
                </button>
              )}
            </section>
          )}
          <section>
            <label className="field">
              파일 탐색기 기본 폴더
              <input
                aria-label="파일 탐색기 기본 폴더"
                placeholder={local ? "프로젝트 경로" : "/home/사용자"}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </label>
            <details>
              <summary>고급 설정</summary>
              {!local && (
                <label className="field">
                  SSH 키 파일
                  <input
                    aria-label="SSH 키 파일"
                    placeholder="C:\Users\…\.ssh\id_ed25519"
                    value={identityFile}
                    onChange={(e) => setIdentityFile(e.target.value)}
                  />
                </label>
              )}
              <label className="field">
                Codex 실행 파일
                <input
                  aria-label="Codex 실행 파일"
                  value={codexPath}
                  onChange={(e) => setCodexPath(e.target.value)}
                />
              </label>
            </details>
          </section>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="host-save-notice" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
        </div>
        <footer>
          {!local && (
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => void action("test")}
            >
              {busy === "test" ? "확인 중…" : "연결 확인"}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => void action("save")}
          >
            저장
          </button>
          <button className="button primary" disabled={!!busy}>
            {busy === "connect" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
            연결
          </button>
        </footer>
      </form>
    </aside>
  );
}
