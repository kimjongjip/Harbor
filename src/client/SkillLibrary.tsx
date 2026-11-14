import { useEffect, useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import type { HostView } from "../shared/types";
import {
  SKILL_CATALOG,
  skillFolder,
  skillInvocation,
  type SkillProvider,
  type SkillLibraryStatus,
  type SkillInstallResult,
} from "../shared/skill-catalog";
import {
  SKILL_SOURCES,
  SKILL_CHECKED_AT,
  skillSource,
  skillSourceUrl,
} from "../shared/skill-sources";
import { Modal } from "./Dialogs";
import { api, ApiError } from "./api";
import "./skill-library.css";
import { CodexContextSettings } from "./HostInsights";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [category, setCategory] = useState("전체");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sort, setSort] = useState("research");
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
      (sourceFilter === "all" ||
        (skill.source || "anthropic") === sourceFilter) &&
      `${skill.title} ${skill.id} ${skill.description} ${skillSource(skill.source).name}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  ).sort((a, b) =>
    sort === "stars"
      ? skillSource(b.source).stars - skillSource(a.source).stars
      : sort === "name"
        ? a.title.localeCompare(b.title, "ko")
        : Number(b.category.includes("연구")) -
          Number(a.category.includes("연구")),
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
      subtitle={host.name}
      wide
      isolateEvents
      backdropClassName="skill-library-backdrop"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="skill-library-body">
        <div className="skill-utilities">
          <details
            className="skill-settings"
            onToggle={(e) => setSettingsOpen(e.currentTarget.open)}
          >
            <summary>Codex 설정</summary>
            {settingsOpen && <CodexContextSettings hostId={host.id} />}
          </details>
          <details className="skill-help">
            <summary>사용법</summary>
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
                  Claude는 <code>/</code>, Codex는 <code>/skills</code>에서
                  목록을 확인하세요. 설치 후 인식되지 않으면 작업을 저장한 뒤 새
                  CLI 세션을 여세요. Harbor가 실행 중인 세션을 종료하지는
                  않습니다.
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
                  <code>claude auth login</code>, Codex의{" "}
                  <code>codex login</code>
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
        </div>
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
          <details className="skill-install-roots">
            <summary>설치 위치</summary>
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
            <p>
              이 서버 계정의 모든 프로젝트에 적용됩니다. 기존 폴더는 보존합니다.
            </p>
          </details>
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
              placeholder="스킬 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="스킬 분야"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {[
              "전체",
              "연구",
              "AI·시스템 연구",
              "문서·데이터",
              "디자인",
              "개발",
              "업무·학습",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            aria-label="스킬 출처"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="all">모든 출처</option>
            {SKILL_SOURCES.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
          <select
            aria-label="스킬 정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="research">연구 우선</option>
            <option value="stars">저장소 별 수순</option>
            <option value="name">이름순</option>
          </select>
          <span>{filtered.length}개</span>
        </div>
        <div className="skill-cards">
          {filtered.map((skill) => {
            const origin = skillSource(skill.source),
              guide = skill.kind === "guide";
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
                  {!guide && (
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
                  )}
                  <div>
                    <h4>{skill.title}</h4>
                  </div>
                  <span>{skill.category}</span>
                </label>
                <div className="skill-card-source">
                  <a
                    href={skillSourceUrl(skill.source)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {origin.name} ↗
                  </a>
                  <span
                    title={`저장소 전체 별 수 · 개별 스킬 평가가 아닙니다. ${origin.repo} · ${SKILL_CHECKED_AT} 확인`}
                  >
                    ★{" "}
                    {new Intl.NumberFormat("en", {
                      notation: "compact",
                      maximumFractionDigits: 1,
                    }).format(origin.stars)}
                  </span>
                </div>
                <p>{skill.description}</p>
                <div className="skill-badges">
                  {guide ? (
                    <span>독립 도구 · 연결 안내</span>
                  ) : (
                    providers.map((provider) => {
                      const state = status?.skills[skill.id]?.[provider];
                      if (state === "available") return null;
                      return (
                        <span key={provider} data-state={state}>
                          {state === "installed" && <Check size={12} />}
                          {provider === "claude" ? "Claude" : "Codex"} ·{" "}
                          {state === "installed"
                            ? "설치됨"
                            : state === "existing"
                              ? "기존 폴더 있음"
                              : state === "unavailable"
                                ? "경로 확인 필요"
                                : status
                                  ? "Harbor 업데이트 필요"
                                  : "확인 전"}
                        </span>
                      );
                    })
                  )}
                  {skill.source === "openrig" && (
                    <span>안내 스킬 · OpenRig 실행 환경은 별도</span>
                  )}
                </div>
                <details className="skill-card-details">
                  <summary>
                    {guide ? "공식 연결 방법·필요한 환경" : "사용법"}
                  </summary>
                  <div>
                    {guide ? (
                      <>
                        <p>
                          사용할 프로젝트의 터미널에서 아래 공식 명령을 검토해
                          실행하세요. Harbor는 명령을 자동 실행하지 않습니다.
                        </p>
                        <div className="skill-example">
                          <span>터미널</span>
                          <code>{skill.guideCommands?.join("\n")}</code>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`${skill.title} 연결 명령 복사`}
                            onClick={() =>
                              void copy(
                                skill.guideCommands?.join("\n") || "",
                                `${skill.id}-guide`,
                              )
                            }
                          >
                            {copied === `${skill.id}-guide` ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      </>
                    ) : (
                      (["claude", "codex"] as const).map((provider) => (
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
                      ))
                    )}
                    {skill.requirements && (
                      <p>
                        {skill.requirements}{" "}
                        {!guide &&
                          "설치 버튼은 이 프로그램들을 자동 설치하지 않습니다."}
                      </p>
                    )}
                    {skill.caveat && (
                      <p className="skill-caveat">{skill.caveat}</p>
                    )}
                    {!guide && (
                      <p>
                        양쪽에 같은 원본 파일을 설치합니다. Claude 전용
                        도구·명령이 포함된 부분은 Codex에서 조정이 필요할 수
                        있습니다.
                      </p>
                    )}
                    <a
                      href={`${skillSourceUrl(skill.source)}/tree/${origin.commit}${guide ? "" : `/${skillFolder(skill)}`}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {guide ? "공식 연결 안내" : "원본 지침"} ↗
                    </a>
                    <span className="skill-origin-version">
                      {" "}
                      · {origin.commit.slice(0, 7)} · {origin.license}
                    </span>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
        {!filtered.length && (
          <p className="skill-empty">검색에 맞는 스킬이 없습니다.</p>
        )}
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
