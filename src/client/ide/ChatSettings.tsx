import { useEffect, useRef, useState } from "react";
import "./chat-settings.css";
import { Modal } from "../Dialogs";
import type {
  ChatEffort,
  ChatPermission,
  IdeChatProvider,
} from "../../shared/ide-chat";
import type { ResearchModel } from "../../shared/research";
import { researchEffortLabel } from "../../shared/research";
import type { IdeChatRequest } from "./IdeChatPanel";
import type { WorkspaceUpdateStatus } from "../../shared/types";
import type { TerminalUsage } from "../../shared/terminal-usage";
import { WorkspaceUpdateState } from "../WorkspaceUpdateState";

export type ChatSettingsField = keyof ChatSettingsValue;
export type ChatSettingsValue = {
  model: string;
  effort?: ChatEffort;
  permission: ChatPermission;
};
export function chatModelOption(models: ResearchModel[], id: string) {
  return id
    ? (models.find((m) => m.id === id) ??
        models.find((m) => m.resolvedModel === id))
    : models.find((m) => m.isDefault);
}
export const permissionLabels: Record<ChatPermission, string> = {
  default: "기본 승인",
  "read-only": "읽기 전용",
  "accept-edits": "편집 허용",
  "auto-accept": "자동 승인",
};

export function useChatModels(
  hostId: string,
  provider: IdeChatProvider,
  request: IdeChatRequest,
  active: boolean,
  scope: string,
  catalogFallback?: IdeChatRequest,
  settingsOpen = false,
) {
  const [, show] = useState(0);
  const cache = useRef(
    new Map<
      string,
      {
        models: ResearchModel[];
        notice: string;
        at: number;
        supportsAutoAccept?: boolean;
      }
    >(),
  );
  const key = scope + ":" + provider;
  useEffect(() => {
    if (
      !hostId ||
      !active ||
      Date.now() - (cache.current.get(key)?.at || 0) < 60000
    )
      return;
    const controller = new AbortController();
    async function load() {
      let models: ResearchModel[] = [],
        notice = "",
        supportsAutoAccept: boolean | undefined;
      const path =
        "/hosts/" + encodeURIComponent(hostId) + "/models?provider=" + provider;
      const read = async (send: IdeChatRequest) => {
        const r = await send(path, { signal: controller.signal });
        if (!r.ok) throw r;
        const data = await r.json();
        if (!Array.isArray(data.models))
          throw Error("모델 목록을 가져올 수 없습니다.");
        return data;
      };
      try {
        const data = await read(request);
        supportsAutoAccept = data.supportsAutoAccept === true;
        models = data.models;
        if(data.notice)notice="모델 목록을 가져올 수 없습니다.";
      } catch (error) {
        if (controller.signal.aborted) return;
        try {
          if (!catalogFallback || catalogFallback === request) throw Error();
          models = (await read(catalogFallback)).models;
          // Only the worker that owns the future conversation can advertise the policy.
          supportsAutoAccept = error instanceof Response && error.status === 404 ? false : undefined;
        } catch {
          notice = "모델 목록을 가져올 수 없습니다.";
        }
      }
      if (controller.signal.aborted) return;
      cache.current.set(key, {
        models,
        notice,
        supportsAutoAccept,
        at: Date.now(),
      });
      if (cache.current.size > 48)
        cache.current.delete(cache.current.keys().next().value!);
      show((v) => v + 1);
    }
    void load();
    return () => controller.abort();
  }, [active, hostId, provider, key, request, catalogFallback,settingsOpen]);
  return (
    cache.current.get(key) || {
      models: [],
      notice: "",
      at: 0,
      supportsAutoAccept: undefined,
    }
  );
}
export function ChatSettings({
  hostName,
  provider,
  initial,
  observed,
  lastTurnPolicy,
  workspaceUpdate,
  unknown,
  models,
  notice,
  bound,
  originalTerminal,
  nativeConfiguration,
  review,
  active,
  status,
  onSave,
  autoAccept,
  autoUnavailable,
  pendingDraftAuto,
  onAutoAccept,
  onClose,
}: {
  hostName: string;
  provider: IdeChatProvider;
  initial: ChatSettingsValue;
  observed?: { model?: string; effort?: ChatEffort };
  lastTurnPolicy?: TerminalUsage["codexTurnPolicy"];
  workspaceUpdate?: WorkspaceUpdateStatus;
  unknown?: { model?: boolean; effort?: boolean; permission?: boolean };
  models: ResearchModel[];
  notice: string;
  bound: boolean;
  originalTerminal?: boolean;
  nativeConfiguration?: boolean;
  review: boolean;
  active: boolean;
  status?: string;
  onSave: (
    settings: ChatSettingsValue,
    engineChanged: boolean,
    fields: ChatSettingsField[],
  ) => Promise<void>;
  autoAccept?: boolean;
  autoUnavailable?: string;
  pendingDraftAuto?: boolean;
  onAutoAccept: (enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [edits, setEdits] = useState<Partial<ChatSettingsValue>>({});
  const values = { ...initial, ...edits };
  const { model, effort, permission } = values;
  const changed = (Object.keys(edits) as ChatSettingsField[]).filter(
    (field) => values[field] !== initial[field] || unknown?.[field],
  );
  const [toggling, setToggling] = useState(false);
  const setModel = (value: string) =>
    setEdits((old) => ({ ...old, model: value, effort: undefined }));
  const setEffort = (value: ChatEffort | undefined) =>
    setEdits((old) => ({ ...old, effort: value }));
  const setPermission = (value: ChatPermission) =>
    setEdits((old) => ({ ...old, permission: value }));
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const unknownModel = !!unknown?.model && !Object.hasOwn(edits, "model");
  const unknownEffort = !!unknown?.effort && !Object.hasOwn(edits, "effort");
  const unknownPermission =
    !!unknown?.permission && !Object.hasOwn(edits, "permission");
  const isReadOnly = review || initial.permission === "read-only";
  const chosen = unknownModel ? undefined : chatModelOption(models, model);
  const measured =
    active &&
    observed &&
    ((observed.model &&
      (!model ||
        (model !== observed.model &&
          chosen?.resolvedModel !== observed.model))) ||
      (observed.effort && observed.effort !== effort))
      ? [observed.model, observed.effort].filter(Boolean).join(" · ")
      : "";
  const efforts =
    chosen?.efforts?.filter((v): v is ChatEffort => v !== "default") || [];
  const permissions: ChatPermission[] =
    provider === "codex"
      ? ["default", "read-only"]
      : provider === "claude"
        ? ["default", "read-only", "accept-edits"]
        : ["default"];
  const busy = active && (status === "running" || status === "waiting");
  // These workers can start conversations but have no running-session settings endpoint.
  const legacySettings = active && /^2\.0\.[0-4]$/.test(workspaceUpdate?.runningVersion || "");
  const nativeAgy = bound && provider === "antigravity";
  const immutable =
    review || legacySettings || (busy && !bound) || (bound && !nativeAgy);
  const lockEngine = immutable || (bound && (!nativeConfiguration || busy));
  const {sandbox,approval} = lastTurnPolicy || {};
  const policyText = [
    sandbox && {"read-only":"읽기 전용","workspace-write":"작업 폴더 쓰기","danger-full-access":"전체 접근","external-sandbox":"외부 샌드박스"}[sandbox],
    approval && {"on-request":"요청 시 승인","untrusted":"신뢰한 명령만 허용","on-failure":"실패 시 승인","never":"승인 요청 안 함"}[approval],
  ].filter(Boolean).join(" · ");
  const unsupportedEffort = nativeAgy && chosen && !efforts.length && !effort;
  async function save() {
    if (saving || immutable) return;
    setSaving(true);
    setError("");
    try {
      if (changed.length)
        await onSave(
          { model: model.trim(), effort, permission },
          changed.includes("model") || changed.includes("effort"),
          changed,
        );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="대화 실행 설정"
      subtitle={
        hostName +
        " · " +
        { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity" }[
          provider
        ]
      }
      backdropClassName="chat-settings-dialog"
      onClose={onClose}
      isolateEvents
    >
      <form
        className="chat-execution-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="chat-settings-fields">
          {workspaceUpdate && workspaceUpdate.phase !== "current" && <WorkspaceUpdateState status={workspaceUpdate} inSettings />}
          <label>
            모델
            {models.length > 0 || !notice ? (
              <select
                aria-label="AI 모델"
                disabled={lockEngine || saving || !models.length}
                title={
                  unknownModel ? undefined : chosen?.name || model || undefined
                }
                value={
                  unknownModel
                    ? "__unreported"
                    : model
                      ? chosen?.id || model
                      : ""
                }
                onChange={(e) => {
                  setModel(e.target.value);
                }}
              >
                {unknownModel && (
                  <option value="__unreported" disabled>
                    현재 모델 미확인
                  </option>
                )}
                {(!nativeAgy || !model && !unknownModel) && <option value="" disabled={nativeAgy}>
                  {!models.length && !notice
                    ? "모델 목록 확인 중…"
                    : nativeAgy ? "현재 모델 미확인" : models.find((m) => m.isDefault)?.name
                      ? "기본 · " + models.find((m) => m.isDefault)!.name
                      : "계정 기본 모델"}
                </option>}
                {model && !chosen && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="AI 모델"
                maxLength={160}
                disabled={lockEngine || saving}
                value={model}
                placeholder={
                  unknownModel ? "현재 모델 미확인" : "계정 기본 모델"
                }
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort(undefined);
                }}
              />
            )}
          </label>
          <label>
            추론 강도
            <select
              aria-label="추론 강도"
              disabled={lockEngine || saving || (!efforts.length && !effort)}
              value={unknownEffort && !unsupportedEffort ? "__unreported" : effort || ""}
              onChange={(e) =>
                setEffort(
                  (e.target.value || undefined) as ChatEffort | undefined,
                )
              }
            >
              {unknownEffort && !unsupportedEffort && (
                <option value="__unreported" disabled>
                  현재 강도 미확인
                </option>
              )}
              {(!nativeAgy || !effort) && <option value="" disabled={nativeAgy}>
                {unsupportedEffort ? "선택 가능한 강도 없음" : nativeAgy ? "강도 선택" : chosen?.defaultEffort && chosen.defaultEffort !== "default"
                  ? "모델 기본값 · " + chosen.defaultEffort
                  : "모델 기본값"}
              </option>}
              {effort && !efforts.includes(effort) && (
                <option value={effort}>{effort}</option>
              )}
              {efforts.map((v) => (
                <option key={v} value={v}>
                  {researchEffortLabel[v] || v}
                </option>
              ))}
            </select>
          </label>
          <label>
            실행 권한
            <select
              aria-label="AI 권한"
              disabled={immutable || saving || permissions.length < 2}
              value={unknownPermission ? "__unreported" : permission}
              onChange={(e) => setPermission(e.target.value as ChatPermission)}
            >
              {unknownPermission && (
                <option value="__unreported" disabled>
                  {policyText ? "지난 턴 · " + policyText : legacySettings ? "이 서버 버전에서 권한 미제공" : "현재 권한 미확인"}
                </option>
              )}
              {permissions.map((p) => (
                <option key={p} value={p}>
                  {permissionLabels[p]}
                </option>
              ))}
            </select>
          </label>
          {measured && (
            <p className="chat-measured">
              엔진에서 마지막으로 확인 · {measured}
            </p>
          )}
          <section className="chat-auto-accept" aria-label="Harbor 승인 설정">
            <div>
              <strong>Harbor 자동 수락</strong>
              {(autoAccept !== undefined || isReadOnly) && <p>
                {isReadOnly
                  ? "읽기 전용 대화"
                  : "이 대화의 명령 실행·파일 변경·권한 요청을 자동 승인합니다. 답변이 필요한 질문은 직접 응답합니다."}
              </p>}
            </div>
            {autoAccept === undefined && !isReadOnly ? (
              <div className="chat-auto-unavailable"><span role="status">{autoUnavailable || "상태 미제공"}</span>{pendingDraftAuto && <button type="button" className="button secondary small" onClick={()=>void onAutoAccept(false)}>예약 해제</button>}</div>
            ) : (
              <button
                type="button"
                role="switch"
                aria-label="Harbor 자동 수락"
                aria-checked={autoAccept === true}
                disabled={isReadOnly || toggling || saving}
                onClick={async () => {
                  setToggling(true);
                  setError("");
                  try {
                    await onAutoAccept(!autoAccept);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setToggling(false);
                  }
                }}
              >
                <span aria-hidden="true" className="switch-track" />
                {toggling ? "적용 중…" : autoAccept ? "켬" : "끔"}
              </button>
            )}
          </section>
          {legacySettings && !bound ? (
            <p>이 서버 버전에서는 열린 대화의 실행 설정을 변경할 수 없습니다.</p>
          ) : review ? (
            <p>이 검토 대화는 읽기 전용입니다.</p>
          ) : busy && !bound ? (
            <p>현재 작업이 끝나면 설정을 변경할 수 있습니다.</p>
          ) : bound && lockEngine ? (
            <p>
              {provider === "antigravity"
                ? busy && nativeConfiguration
                  ? "모델과 추론 강도는 응답이 끝나면 변경할 수 있습니다."
                  : originalTerminal ? "원본 터미널에서 /model 또는 /effort로 변경할 수 있습니다."
                    : "이 Antigravity 연결은 모델 설정을 제공하지 않습니다. 서버 업데이트 후 기록에서 같은 대화를 다시 여세요."
                : originalTerminal ? "현재 세션의 설정은 원본 터미널에서 변경하세요." : "현재 연결에서는 실행 설정을 변경할 수 없습니다."}
            </p>
          ) : (
            active &&
            !!changed.length && (
              <p>변경한 실행 설정은 다음 요청부터 적용됩니다.</p>
            )
          )}
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            닫기
          </button>
          {!immutable && (
            <button
              type="submit"
              className="button primary"
              disabled={saving || toggling || !changed.length || (nativeAgy && edits.model === "")}
            >
              {saving ? "저장 중…" : "적용"}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
