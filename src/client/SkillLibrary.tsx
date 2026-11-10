import { useEffect, useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import type { HostView } from "../shared/types";
import {
  SKILL_CATALOG,
  SKILL_SOURCE,
  skillInvocation,
  type SkillProvider,
  type SkillLibraryStatus,
  type SkillInstallResult,
} from "../shared/skill-catalog";
import { Modal } from "./Dialogs";
import { api, ApiError } from "./api";
import "./skill-library.css";

export function SkillLibraryButton({ host }: { host: HostView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="host-skills-button"
        aria-label={`${host.name} 스킬 설치·사용법`}
        title="한국어 스킬 목록 · Claude·Codex에 설치"
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <BookOpen size={15} />
        <span>스킬</span>
      </button>
      {open && (
        <SkillLibraryDialog
          key={host.id}
          host={host}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function SkillLibraryDialog({
  host,
  onClose,
}: {
  host: HostView;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("전체");
  const [target, setTarget] = useState("both");
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<SkillLibraryStatus>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<SkillInstallResult[]>([]);
  const [copied, setCopied] = useState("");
  const providers: SkillProvider[] =
    target === "both" ? ["claude", "codex"] : [target as SkillProvider];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setStatus(undefined);
    api<SkillLibraryStatus>(
      `/hosts/${encodeURIComponent(host.id)}/skills`,
      undefined,
      "GET",
      controller.signal,
    )
      .then(setStatus)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof SyntaxError ||
              (e instanceof ApiError && e.status === 404)
              ? "현재 실행 중인 Harbor 서버에는 스킬 설치 기능이 아직 없습니다. 작업을 마친 뒤 새 버전으로 Harbor를 다시 실행하면 설치할 수 있습니다. 목록과 사용법은 지금 확인할 수 있습니다."
              : (e as Error).message,
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [host.id, refresh]);
  const filtered = SKILL_CATALOG.filter(
    (skill) =>
      (category === "전체" || skill.category === category) &&
      `${skill.title} ${skill.id} ${skill.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const installable = selected.filter((id) =>
    providers.some(
      (provider) => status?.skills[id]?.[provider] === "available",
    ),
  );
  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setError("복사하지 못했습니다. 표시된 예시를 직접 선택해 복사하세요.");
    }
  };
  const install = async () => {
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const response = await api<{ results: SkillInstallResult[] }>(
        `/hosts/${encodeURIComponent(host.id)}/skills/install`,
        { ids: installable, providers },
      );
      setResults(response.results);
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="스킬 라이브러리"
      subtitle={`${host.name} · ${host.kind === "local" ? "이 컴퓨터의 사용자" : `${host.username || "SSH 로그인 사용자"} 계정`}`}
      wide
      isolateEvents
      backdropClassName="skill-library-backdrop"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="skill-library-body">
        <section className="skill-intro">
          <BookOpen size={27} />
          <div>
            <h3>필요한 작업 방법을 AI에게 더해보세요</h3>
            <p>
              스킬은 AI가 필요할 때 읽는 작업 설명서와 도구 모음입니다. 한국어
              설명을 보고 필요한 것만 골라 설치하세요.
            </p>
          </div>
          <a href={SKILL_SOURCE.url} target="_blank" rel="noreferrer">
            Anthropic 원본 <ExternalLink size={13} />
          </a>
        </section>
        <details className="skill-help">
          <summary>처음 사용하시나요? 사용법·로그인 안내</summary>
          <div className="skill-help-grid">
            <section>
              <h4>매번 지정해야 하나요?</h4>
              <p>
                보통은 작업과 스킬 설명이 맞으면 AI가 자동으로 선택합니다.
                확실히 사용하고 싶다면 직접 지정하세요. 조직 정책이나 스킬
                설정에 따라 자동 선택이 제한될 수 있습니다.
              </p>
              <p>
                <strong>Claude Code</strong>{" "}
                <code>/pdf 이 문서의 표를 추출해줘</code>
              </p>
              <p>
                <strong>Codex CLI</strong>{" "}
                <code>$pdf 이 문서의 표를 추출해줘</code>
              </p>
              <p>
                Claude는 <code>/</code>, Codex는 <code>/skills</code>에서 목록을
                확인하세요. 설치 후 인식되지 않으면 작업을 저장한 뒤 새 CLI
                세션을 여세요. Harbor가 실행 중인 세션을 종료하지는 않습니다.
              </p>
            </section>
            <section>
              <h4>Harbor에서 따로 로그인하나요?</h4>
              <p>
                같은 서버·같은 OS 계정에서 로그인한 CLI 인증을 그대로
                사용합니다. Harbor에 AI 비밀번호를 등록할 필요는 없습니다.
                Claude와 OpenAI 로그인·요금제는 서로 별개입니다.
              </p>
              <p>
                처음 쓰는 서버에서는 본인 터미널에서 Claude의{" "}
                <code>claude auth login</code>, Codex의 <code>codex login</code>
                으로 각각 로그인합니다. 원격 Codex는{" "}
                <code>codex login --device-auth</code>를 사용할 수 있습니다.
              </p>
              <p>
                다른 사람은 각자의 OS/SSH 계정과 AI 서비스 계정을 사용하세요.
                같은 OS 계정을 공유하면 스킬과 CLI 로그인도 공유됩니다. 이
                설치는 Claude.ai·ChatGPT 웹 계정에 업로드하는 기능이 아닙니다.
              </p>
            </section>
          </div>
          <div className="skill-help-links">
            <a
              href="https://code.claude.com/docs/en/skills"
              target="_blank"
              rel="noreferrer"
            >
              Claude 스킬 안내 ↗
            </a>
            <a
              href="https://learn.chatgpt.com/docs/build-skills"
              target="_blank"
              rel="noreferrer"
            >
              Codex 스킬 안내 ↗
            </a>
            <a
              href="https://code.claude.com/docs/en/authentication"
              target="_blank"
              rel="noreferrer"
            >
              Claude 로그인 ↗
            </a>
            <a
              href="https://learn.chatgpt.com/docs/auth"
              target="_blank"
              rel="noreferrer"
            >
              Codex 로그인 ↗
            </a>
          </div>
        </details>
        <div className="skill-install-settings">
          <label>
            설치할 AI
            <select
              aria-label="설치할 AI"
              value={target}
              disabled={busy}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="both">Claude + Codex 둘 다</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex CLI</option>
            </select>
          </label>
          <div className="skill-install-roots">
            {providers.map((provider) => (
              <div key={provider}>
                <strong>{provider === "claude" ? "Claude" : "Codex"}</strong>
                <code>
                  {status?.roots[provider] ||
                    (provider === "claude"
                      ? "~/.claude/skills"
                      : "~/.agents/skills")}
                </code>
              </div>
            ))}
            <small>
              선택한 서버 계정의 모든 프로젝트에 적용 · 기존 폴더는 보존
            </small>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="스킬 설치 상태 새로고침"
            title="설치 상태 새로고침"
            disabled={busy || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {status?.errors &&
          providers.map(
            (provider) =>
              status.errors?.[provider] && (
                <div key={provider} className="form-error" role="alert">
                  {provider === "claude" ? "Claude" : "Codex"}:{" "}
                  {status.errors[provider]}
                </div>
              ),
          )}
        {loading && (
          <div className="skill-feedback" role="status">
            <LoaderCircle size={15} className="skill-spinner" />
            서버의 설치 상태 확인 중…
          </div>
        )}
        {!!results.length && (
          <section
            className="skill-results"
            role="status"
            aria-label="스킬 설치 결과"
          >
            <strong>설치 결과</strong>
            {results.map((r) => (
              <div
                key={`${r.id}-${r.provider}`}
                className={r.state === "error" ? "skill-result-error" : ""}
              >
                {r.state === "installed"
                  ? "✓ 설치 완료"
                  : r.state === "existing"
                    ? "기존 폴더 보존"
                    : "설치 실패"}{" "}
                · {r.id} · {r.provider === "claude" ? "Claude" : "Codex"}
                {r.message && ` — ${r.message}`}
              </div>
            ))}
          </section>
        )}
        <div className="skill-filters">
          <label>
            <Search size={17} />
            <input
              aria-label="스킬 검색"
              placeholder="한국어 설명이나 스킬 이름으로 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="스킬 분야"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {["전체", "문서·데이터", "디자인", "개발", "업무·학습"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span>{filtered.length}개</span>
        </div>
        <div className="skill-cards">
          {filtered.map((skill) => {
            const checked = selected.includes(skill.id),
              available = providers.some(
                (provider) =>
                  status?.skills[skill.id]?.[provider] === "available",
              );
            return (
              <article
                key={skill.id}
                className={`skill-card ${checked ? "selected" : ""}`}
                data-skill-id={skill.id}
              >
                <label className="skill-card-heading">
                  <input
                    type="checkbox"
                    aria-label={`${skill.title} 선택`}
                    checked={checked}
                    disabled={busy || !available}
                    onChange={() =>
                      setSelected((current) =>
                        checked
                          ? current.filter((id) => id !== skill.id)
                          : [...current, skill.id],
                      )
                    }
                  />
                  <div>
                    <h4>{skill.title}</h4>
                    <code>{skill.id}</code>
                  </div>
                  <span>{skill.category}</span>
                </label>
                <p>{skill.description}</p>
                <div className="skill-badges">
                  {(["claude", "codex"] as const).map((provider) => {
                    const state = status?.skills[skill.id]?.[provider];
                    return (
                      <span key={provider} data-state={state}>
                        {state === "installed" && <Check size={12} />}
                        {provider === "claude" ? "Claude" : "Codex"} ·{" "}
                        {state === "installed"
                          ? "Harbor 설치됨"
                          : state === "existing"
                            ? "기존 폴더 있음"
                            : state === "available"
                              ? "설치 가능"
                              : state === "unavailable"
                                ? "경로 확인 필요"
                                : "확인 전"}
                      </span>
                    );
                  })}
                </div>
                <details className="skill-card-details">
                  <summary>사용 예시·필요한 환경</summary>
                  <div>
                    {(["claude", "codex"] as const).map((provider) => (
                      <div className="skill-example" key={provider}>
                        <span>
                          {provider === "claude" ? "Claude" : "Codex"}
                        </span>
                        <code>{skillInvocation(skill, provider)}</code>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`${skill.title} ${provider} 예시 복사`}
                          onClick={() =>
                            void copy(
                              skillInvocation(skill, provider),
                              `${skill.id}-${provider}`,
                            )
                          }
                        >
                          {copied === `${skill.id}-${provider}` ? (
                            <Check size={14} />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                    ))}
                    {skill.requirements && (
                      <p>
                        {skill.requirements} 설치 버튼은 이 프로그램들을 자동
                        설치하지 않습니다.
                      </p>
                    )}
                    {skill.caveat && (
                      <p className="skill-caveat">{skill.caveat}</p>
                    )}
                    <p>
                      양쪽에 같은 원본 파일을 설치합니다. Claude 전용
                      도구·명령이 포함된 부분은 Codex에서 조정이 필요할 수
                      있습니다.
                    </p>
                    <a
                      href={`${SKILL_SOURCE.url}/tree/${SKILL_SOURCE.commit}/skills/${skill.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      원본 지침·라이선스 보기 ↗
                    </a>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
        {!filtered.length && (
          <p className="skill-empty">검색에 맞는 스킬이 없습니다.</p>
        )}
        <p className="skill-source-note">
          한국어 설명은 Harbor 안내입니다. 설치 파일은 원본을 유지하며, 스크립트
          실행·인증 정보 복사는 하지 않습니다. 원본 확인:{" "}
          {SKILL_SOURCE.checkedAt} · {SKILL_SOURCE.commit.slice(0, 7)}. 최신
          원본은 Harbor 업데이트로 반영합니다.
        </p>
      </div>
      <footer className="modal-footer skill-footer">
        <div>
          <strong>
            {busy
              ? "선택한 스킬을 설치하고 있습니다…"
              : `${installable.length}개 스킬 선택`}
          </strong>
          <span>
            {busy
              ? "파일 다운로드와 서버 복사 중 · 터미널 작업은 계속 실행됩니다."
              : `대상: ${host.name} · ${target === "both" ? "Claude + Codex" : target === "claude" ? "Claude" : "Codex"}`}
          </span>
        </div>
        <button className="button ghost" disabled={busy} onClick={onClose}>
          닫기
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || loading || !status || !installable.length}
          onClick={() => void install()}
        >
          {busy ? (
            <LoaderCircle className="skill-spinner" size={16} />
          ) : (
            <Download size={16} />
          )}
          {busy ? "설치 중…" : "선택한 스킬 설치"}
        </button>
      </footer>
    </Modal>
  );
}
