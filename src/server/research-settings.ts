import { z } from "zod";
import {
  codexModelId,
  researchEfforts,
  researchEffortsFor,
} from "../shared/research.js";
import type {
  ResearchAgentSettings,
  ResearchEffort,
  ResearchModel,
  ResearchParticipant,
} from "../shared/research.js";
import type { TerminalOptions } from "./terminal-shell.js";

export function researchReconnectOptions(
  participant: Pick<ResearchParticipant, "owned" | "kind" | "cwd">,
  validatedSettings?: ResearchAgentSettings,
): Pick<TerminalOptions, "researchLaunch" | "resumeCwd"> {
  if (participant.owned) {
    if (!validatedSettings)
      throw new Error("연구실 실행 설정을 먼저 확인하세요.");
    return { researchLaunch: { cwd: participant.cwd, ...validatedSettings } };
  }
  // Resuming an existing research Claude requests its per-launch peer channel,
  // with no model/effort flags; native resume settings and channel consent stay native.
  return participant.kind === "claude"
    ? { researchLaunch: { cwd: participant.cwd, effort: "default" } }
    : { resumeCwd: participant.cwd };
}

export const researchSettingsSchema = z
  .object({
    model: z
      .string()
      .trim()
      .max(150)
      .refine(
        (value) =>
          !value || /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-\[\]]*$/.test(value),
        "모델 ID에는 공백이나 셸 제어 문자를 사용할 수 없습니다.",
      )
      .transform((value) => value || undefined)
      .optional(),
    effort: z.enum(researchEfforts),
  })
  .strict();

export function researchSettings(
  kind: "codex" | "claude",
  input: unknown,
  fallback: ResearchEffort = "default",
): ResearchAgentSettings {
  const settings = researchSettingsSchema.parse(input ?? { effort: fallback });
  if (!researchEffortsFor(kind).includes(settings.effort))
    throw new Error(
      `${kind === "claude" ? "Claude" : "Codex"}에서 지원하지 않는 effort 설정입니다.`,
    );
  return kind === "codex" && settings.model
    ? { ...settings, model: codexModelId(settings.model) }
    : settings;
}

/** Read-only preflight, before creating any terminal or research workspace. */
export async function validateResearchSettings(
  kind: "codex" | "claude",
  input: ResearchAgentSettings,
  load: () => Promise<ResearchModel[]>,
): Promise<ResearchAgentSettings> {
  const settings = researchSettings(kind, input);
  if (kind !== "codex" || (!settings.model && settings.effort === "default"))
    return settings;
  let models: ResearchModel[];
  try {
    models = await load();
  } catch {
    throw new Error(
      "이 서버의 Codex 모델 목록을 확인하지 못했습니다. CLI 로그인·연결을 확인하고 다시 시도하거나 모델·추론 노력을 CLI 기본 설정으로 선택하세요.",
    );
  }
  const model = settings.model
    ? models.find((m) => m.id.toLowerCase() === settings.model!.toLowerCase())
    : models.find((m) => m.isDefault);
  if (!model)
    throw new Error(
      settings.model
        ? `이 서버의 Codex 계정에서 ${settings.model} 모델을 사용할 수 없습니다. 모델 목록이나 CLI의 /model에서 선택하세요.`
        : "이 서버의 Codex 기본 모델을 확인할 수 없습니다. 모델을 직접 선택하거나 추론 노력을 CLI 기본 설정으로 선택하세요.",
    );
  if (
    settings.effort !== "default" &&
    !model.efforts?.includes(settings.effort)
  )
    throw new Error(
      `${model.name}에서 ${settings.effort} 추론 노력을 지원하는지 확인할 수 없거나 지원하지 않습니다. 목록의 지원 값이나 CLI 기본 설정을 선택하세요.`,
    );
  return { ...settings, ...(settings.model ? { model: model.id } : {}) };
}

export function researchArguments(
  kind: "codex" | "claude",
  input: ResearchAgentSettings,
): string[] {
  const settings = researchSettings(kind, {
    model: input.model,
    effort: input.effort,
  });
  const args = settings.model ? ["--model", settings.model] : [];
  if (settings.effort !== "default") {
    if (kind === "claude") args.push("--effort", settings.effort);
    else args.push("-c", `model_reasoning_effort="${settings.effort}"`);
  }
  return args;
}
