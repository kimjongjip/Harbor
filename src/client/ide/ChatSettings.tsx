import { useEffect, useRef, useState } from "react";
import { Modal } from "../Dialogs";
import type {
  ChatEffort,
  ChatPermission,
  IdeChatProvider,
} from "../../shared/ide-chat";
import type { ResearchModel } from "../../shared/research";
import { researchEffortLabel } from "../../shared/research";
import type { IdeChatRequest } from "./IdeChatPanel";

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
) {
  const [, show] = useState(0);
  const cache = useRef(
    new Map<string, { models: ResearchModel[]; notice: string; at: number }>(),
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
        notice = "";
      try {
        const r = await request(
          "/hosts/" +
            encodeURIComponent(hostId) +
            "/models?provider=" +
            provider,
          { signal: controller.signal },
        );
        const data = await r.json();
        if (!r.ok || !Array.isArray(data.models))
          throw Error("모델 목록을 가져올 수 없습니다.");
        models = data.models;
      } catch {
        notice = "모델 목록을 가져올 수 없습니다.";
      }
      if (controller.signal.aborted) return;
      cache.current.set(key, { models, notice, at: Date.now() });
      if (cache.current.size > 48)
        cache.current.delete(cache.current.keys().next().value!);
      show((v) => v + 1);
    }
    void load();
    return () => controller.abort();
  }, [active, hostId, provider, key, request]);
  return cache.current.get(key) || { models: [], notice: "", at: 0 };
}
export function ChatSettings({
  hostName,
  provider,
  initial,
  models,
  notice,
  bound,
  nativeConfiguration,
  review,
  active,
  status,
  onSave,
  onClose,
}: {
  hostName: string;
  provider: IdeChatProvider;
  initial: ChatSettingsValue;
  models: ResearchModel[];
  notice: string;
  bound: boolean;
  nativeConfiguration?: boolean;
  review: boolean;
  active: boolean;
  status?: string;
  onSave: (
    settings: ChatSettingsValue,
    engineChanged: boolean,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const opened = useRef(initial);
  const [model, setModel] = useState(initial.model),
    [effort, setEffort] = useState(initial.effort),
    [permission, setPermission] = useState(initial.permission);
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const chosen = chatModelOption(models, model);
  const efforts =
    chosen?.efforts?.filter((v): v is ChatEffort => v !== "default") || [];
  const permissions: ChatPermission[] =
    provider === "codex"
      ? ["default", "read-only"]
      : provider === "claude"
        ? ["default", "read-only", "accept-edits"]
        : ["default", "auto-accept"];
  const busy = active && (status === "running" || status === "waiting");
  const immutable =
    review || (busy && !bound) || (bound && provider !== "antigravity");
  const lockEngine = immutable || (bound && (!nativeConfiguration || busy));
  async function save() {
    if (saving || immutable) return;
    setSaving(true);
    setError("");
    try {
      await onSave(
        { model: model.trim(), effort, permission },
        model.trim() !== opened.current.model ||
          effort !== opened.current.effort,
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
      subtitle={hostName}
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
        <label>
          모델
          {models.length > 0 ? (
            <select
              aria-label="AI 모델"
              disabled={lockEngine || saving}
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setEffort(undefined);
              }}
            >
              <option value="">
                {models.find((m) => m.isDefault)?.name
                  ? "기본 · " + models.find((m) => m.isDefault)!.name
                  : "계정 기본 모델"}
              </option>
              {model && !models.some((m) => m.id === model) && (
                <option value={model}>{model}</option>
              )}
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
              placeholder="계정 기본 모델"
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
            value={effort || ""}
            onChange={(e) =>
              setEffort((e.target.value || undefined) as ChatEffort | undefined)
            }
          >
            <option value="">
              {chosen?.defaultEffort && chosen.defaultEffort !== "default"
                ? "모델 기본값 · " + chosen.defaultEffort
                : "모델 기본값"}
            </option>
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
          권한
          <select
            aria-label="AI 권한"
            disabled={immutable || saving}
            value={permission}
            onChange={(e) => setPermission(e.target.value as ChatPermission)}
          >
            {permissions.map((p) => (
              <option key={p} value={p}>
                {permissionLabels[p]}
              </option>
            ))}
          </select>
        </label>
        {review ? (
          <p>이 검토 대화는 읽기 전용입니다.</p>
        ) : busy && !bound ? (
          <p>현재 작업이 끝나면 설정을 변경할 수 있습니다.</p>
        ) : bound && lockEngine ? (
          <p>
            {provider === "antigravity"
              ? busy && nativeConfiguration
                ? "모델과 추론 강도는 응답이 끝나면 변경할 수 있습니다."
                : "이 세션의 모델과 추론 강도는 터미널에서 변경하세요."
              : "현재 세션의 설정은 연결된 터미널에서 변경하세요."}
          </p>
        ) : (
          active && <p>변경한 설정은 다음 요청부터 적용됩니다.</p>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            닫기
          </button>
          {!immutable && (
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? "저장 중…" : "적용"}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
