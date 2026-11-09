import { useEffect, useId, useState } from "react";
import {
  codexModelId,
  researchEffortLabel,
  researchEffortsFor,
} from "../shared/research";
import type {
  ResearchAgentSettings,
  ResearchEffort,
  ResearchModel,
} from "../shared/research";
import { api } from "./api";

export function ResearchSettingsFields({
  kind,
  hostId,
  label,
  model,
  effort,
  onModel,
  onEffort,
}: {
  kind: "codex" | "claude";
  hostId: string;
  label: string;
  model: string;
  effort: ResearchEffort;
  onModel(value: string): void;
  onEffort(value: ResearchEffort): void;
}) {
  const id = useId();
  const [catalog, setCatalog] = useState<{
    hostId: string;
    data?: ResearchModel[];
    error?: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (kind !== "codex" || !hostId) return;
    let active = true;
    setCatalog({ hostId });
    void api<{ data: ResearchModel[] }>(
      `/hosts/${encodeURIComponent(hostId)}/research-models`,
      undefined,
      "GET",
    )
      .then((result) => {
        if (!Array.isArray(result.data))
          throw new Error("모델 목록을 읽을 수 없습니다.");
        if (active) setCatalog({ hostId, data: result.data });
      })
      .catch(() => {
        if (active)
          setCatalog({
            hostId,
            error:
              "모델 목록을 확인하지 못했습니다. 해당 서버의 CLI 로그인·연결을 확인하세요.",
          });
      });
    return () => {
      active = false;
    };
  }, [kind, hostId, refresh]);
  const models = catalog?.hostId === hostId ? catalog.data : undefined;
  const selected = model.trim()
    ? models?.find(
        (m) => m.id.toLowerCase() === codexModelId(model).toLowerCase(),
      )
    : models?.find((m) => m.isDefault);
  const levels =
    kind === "codex" && selected?.efforts
      ? ["default" as const, ...selected.efforts]
      : researchEffortsFor(kind);
  return (
    <fieldset className="research-agent-settings">
      <legend>
        {label} 설정 · {kind === "claude" ? "Claude" : "Codex"}
      </legend>
      <label>
        모델
        <input
          aria-label={`${label} 모델`}
          value={model}
          maxLength={150}
          placeholder="비워 두면 CLI 기본 모델"
          list={id}
          onChange={(e) => onModel(e.target.value)}
          onBlur={() => {
            if (kind === "codex" && model.trim()) onModel(codexModelId(model));
          }}
        />
      </label>
      {kind === "claude" && (
        <datalist id={id}>
          <option value="opus" />
          <option value="sonnet" />
          <option value="haiku" />
          <option value="fable" />
        </datalist>
      )}
      {kind === "codex" && (
        <>
          <datalist id={id}>
            {models?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.isDefault ? " · 기본" : ""}
              </option>
            ))}
          </datalist>
          <p role="status">
            {models
              ? `선택한 서버·계정의 모델 ${models.length}개를 확인했습니다.`
              : catalog?.hostId === hostId && catalog.error
                ? catalog.error
                : "선택한 서버의 모델 목록 확인 중…"}
          </p>
          <button type="button" onClick={() => setRefresh((v) => v + 1)}>
            모델 목록 새로고침
          </button>
          {models && model.trim() && !selected && (
            <p role="alert">
              이 서버·계정의 모델 목록에 없는 ID입니다. 목록에서 지원 모델을
              선택하세요.
            </p>
          )}
        </>
      )}
      <label>
        추론 노력
        <select
          aria-label={`${label} 추론 노력`}
          value={effort}
          onChange={(e) => onEffort(e.target.value as ResearchEffort)}
        >
          {!levels.includes(effort) && (
            <option value={effort}>
              {researchEffortLabel[effort]} · 지원 목록에 없음
            </option>
          )}
          {levels.map((level) => (
            <option key={level} value={level}>
              {researchEffortLabel[level]}
            </option>
          ))}
        </select>
      </label>
      {kind === "codex" && selected?.efforts && !levels.includes(effort) && (
        <p role="alert">
          선택한 모델의 지원 목록에 없는 추론 노력입니다. 지원 값이나 CLI 기본
          설정을 선택하세요.
        </p>
      )}
      <p>
        모델 ID는 CLI의 /model에서 확인할 수 있습니다. 사용 가능한 모델·effort는
        해당 서버의 CLI 버전과 로그인 계정에 따라 다릅니다. 선택한 값이 지원되지
        않으면 새 Codex 실행 전에 안내합니다. 기존 대화의 설정은 해당 CLI에서
        변경합니다.
      </p>
    </fieldset>
  );
}

export function ResearchSettingsSummary({
  kind,
  settings,
  onOpen,
}: {
  kind: "codex" | "claude";
  settings?: ResearchAgentSettings;
  onOpen?(): void;
}) {
  return (
    <div className="research-settings-summary">
      <b>{settings ? "실행 시 지정한 설정" : "기존 대화 설정 유지"}</b>
      {settings && (
        <p>
          {settings.model || "CLI 기본 모델"} ·{" "}
          {researchEffortLabel[settings.effort]}
        </p>
      )}
      <p>
        {settings
          ? " CLI에서 변경한 값은 이 실행 기록에 자동 반영되지 않습니다."
          : " 공동 작업 시작 시 대화 설정을 덮어쓰지 않습니다."}
      </p>
      <details>
        <summary>현재 설정 확인 방법</summary>
        <p>
          {kind === "claude"
            ? "/model과 /effort를 사용합니다. effort 슬라이더의 s는 이번 세션에만 적용합니다."
            : "/model에서 모델을 선택하고, 지원하는 CLI에서는 /reasoning으로 추론 노력을 변경할 수 있습니다."}
        </p>
      </details>
      {onOpen && (
        <button type="button" onClick={onOpen}>
          터미널에서 모델·effort 확인 / 변경
        </button>
      )}
    </div>
  );
}
