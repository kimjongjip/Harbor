import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostConfig } from "../shared/types.js";
import {
  chatEfforts,
  type IdeChatProvider,
  type ChatEffort,
} from "../shared/ide-chat.js";
import type { ResearchModel } from "../shared/research.js";
import { findAntigravity } from "./antigravity.js";
import { withClaudeControl, quotaHostKey } from "./claude-account-usage.js";
import type { History } from "./history.js";
import type { Files } from "./files.js";
import { remoteCodexCommand } from "./ssh.js";
const exec = promisify(execFile);
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-\[\]]{0,159}$/;

export function agyModels(text: string): ResearchModel[] {
  const entries = new Map<string, string>();
  const siblings = new Map<string, number>();
  const variant = /^(.+)-(low|medium|high|xhigh|max)$/;
  for (const line of text.split(/\r?\n/)) {
    const [id, label] = line.trim().split(/\t+/);
    if (!label || !modelId.test(id) || entries.has(id)) continue;
    entries.set(id, label);
    const base = id.match(variant)?.[1];
    if (base) siblings.set(base, (siblings.get(base) || 0) + 1);
  }
  const models = new Map<string, ResearchModel>();
  for (const [id, label] of entries) {
    const match = id.match(variant);
    // With a single fixed level ACP advertises the full model ID, including its suffix.
    const grouped =
      match && ((siblings.get(match[1]) || 0) > 1 || entries.has(match[1]));
    const key = grouped ? match[1] : id;
    const row = models.get(key) || {
      id: key,
      name: grouped ? label.replace(/\s*\([^()]*\)\s*$/, "") : label,
      isDefault: false,
      efforts: [],
    };
    if (grouped && !row.efforts!.includes(match[2] as ChatEffort))
      row.efforts!.push(match[2] as ChatEffort);
    models.set(key, row);
  }
  return [...models.values()].map((m) => ({
    ...m,
    efforts: chatEfforts.filter((e) => m.efforts?.includes(e)),
  }));
}

export class ChatModels {
  private cache = new Map<
    string,
    { at: number; promise: Promise<ResearchModel[]> }
  >();
  constructor(
    private history: History,
    private files: Files,
    private password: (hostId: string) => Promise<string | undefined>,
  ) {}
  list(host: HostConfig, provider: IdeChatProvider) {
    const key = JSON.stringify([quotaHostKey(host), host.codexPath, provider]),
      prior = this.cache.get(key);
    if (prior && Date.now() - prior.at < 60000) return prior.promise;
    const promise = this.load(host, provider)
      .then((rows) => {
        if (!rows.length)
          throw Error("선택한 서버에서 모델 목록을 받지 못했습니다.");
        return rows;
      })
      .catch((error) => {
        if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
        throw error;
      });
    this.cache.set(key, { at: Date.now(), promise });
    if (this.cache.size > 64)
      this.cache.delete(this.cache.keys().next().value!);
    return promise;
  }
  private async load(
    host: HostConfig,
    provider: IdeChatProvider,
  ): Promise<ResearchModel[]> {
    const password = await this.password(host.id);
    if (provider === "codex") return this.history.models(host, password);
    if (provider === "claude")
      return withClaudeControl(host, password, async (session) =>
        (await session.supportedModels())
          .filter((m) => modelId.test(m.value))
          .map((m) => ({
            id: m.value,
            resolvedModel:
              m.resolvedModel && modelId.test(m.resolvedModel)
                ? m.resolvedModel
                : undefined,
            name: m.displayName || m.value,
            isDefault: m.value === "default",
            efforts: m.supportedEffortLevels || [],
          })),
      );
    if (host.kind === "ssh")
      return agyModels(
        await this.files.researchCommand(
          host,
          remoteCodexCommand({ codexPath: "agy" }, ["models"]),
        ),
      );
    const binary = findAntigravity();
    if (!binary) throw Error("Antigravity CLI를 찾을 수 없습니다.");
    return agyModels(
      (
        await exec(binary, ["models"], {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 262144,
        })
      ).stdout,
    );
  }
}
