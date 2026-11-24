import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AntigravityQuota } from "./antigravity-quota.js";
import { Router } from "express";
import { z } from "zod";
import type { HostConfig } from "../shared/types.js";
import type {
  AccountQuota,
  CodexContextSettings,
  QuotaWindow,
} from "../shared/host-insights.js";
import type { Files } from "./files.js";
import type { History } from "./history.js";
import type { TerminalUsage } from "../shared/terminal-usage.js";
import { shellQuote } from "./ssh.js";
import { ClaudeQuotaSource, quotaHostKey, retryAfterSeconds, type claudeUsageControl } from "./claude-account-usage.js";

const numeric = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const text = (v: unknown) =>
  typeof v === "string" ? v.slice(0, 180) : undefined;
const left = (v: number) => Math.max(0, Math.min(100, 100 - v));
export function codexQuota(raw: any, now = Date.now()): AccountQuota {
  const windows: QuotaWindow[] = [];
  const limits =
    raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length
      ? Object.values(raw.rateLimitsByLimitId)
      : [raw.rateLimits];
  for (const limit of limits as any[]) {
    for (const key of ["primary", "secondary"]) {
      const w = limit?.[key];
      if (!numeric(w?.usedPercent)) continue;
      const minutes = w.windowDurationMins;
      const duration =
        minutes >= 1440
          ? `${Math.round(minutes / 1440)}일`
          : minutes > 0
            ? `${Math.round(minutes / 60)}시간`
            : "사용";
      const label = `${text(limit.limitName) || ""} ${duration} 한도`.trim();
      if (
        !windows.some(
          (x) => x.label === label && x.remaining === left(w.usedPercent) && x.resetsAt === (numeric(w.resetsAt) ? w.resetsAt*1000 : undefined),
        )
      )
        windows.push({
          label,
          remaining: left(w.usedPercent),
          ...(numeric(w.resetsAt) ? { resetsAt: w.resetsAt * 1000 } : {}),
        });
    }
  }
  return {
    provider: "codex",
    account: text(raw.account?.email),
    plan: text(raw.account?.planType),
    windows,
    updatedAt: now,
    ...(!windows.length
      ? {
          error:
            "구독 한도를 제공하지 않는 로그인 방식이거나 아직 사용량이 없습니다.",
        }
      : {}),
  };
}
export function claudeQuota(raw: any, now = Date.now()): AccountQuota {
  const windows: QuotaWindow[] = [];
  const limits = Array.isArray(raw.usage?.limits) ? raw.usage.limits : [];
  for (const [key, label] of [
    ["seven_day", "7일 한도"],
    ["seven_day_fable", "7일 Fable 한도"],
  ]) {
    // New usage responses carry model-scoped limits in `limits`, not in
    // seven_day_fable. Keep the older fields as a compatibility fallback.
    const scoped = limits.find(
      (limit: any) =>
        numeric(limit?.percent) &&
        (key === "seven_day"
          ? limit.kind === "weekly_all"
          : limit.kind === "weekly_scoped" &&
            limit.scope?.model?.display_name?.toLowerCase?.() === "fable"),
    );
    const value = scoped
      ? { utilization: scoped.percent, resets_at: scoped.resets_at }
      : raw.usage?.[key];
    if (!numeric(value?.utilization)) continue;
    const reset = Date.parse(value.resets_at);
    windows.push({
      label,
      remaining: left(value.utilization),
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
    });
  }
  return {
    provider: "claude",
    account: text(raw.email),
    plan: text(raw.plan),
    windows,
    updatedAt: now,
    ...(!windows.length
      ? {
          error:
            text(raw.error) ||
            "이 계정의 응답에 7일 사용 한도가 제공되지 않았습니다.",
        }
      : {}),
  };
}

/** Only account-attributed provider measurements are eligible for scheduled input. */
export function reservationLimit(provider:"codex"|"claude", raw:any, model:string, now=Date.now()){
  if(raw.error)return null;
  const quota=provider==="codex" ? codexQuota({account:raw.account,rateLimits:raw.rateLimitsByLimitId?.codex ??
    (!raw.rateLimits?.limitId || raw.rateLimits.limitId==="codex" ? raw.rateLimits : undefined)},now) : claudeQuota(raw,now);
  if(!quota.account || quota.error)return null;
  const relevant=quota.windows.filter(w=>!w.label.includes("Fable") || /fable/i.test(model));
  if(provider==="claude" && numeric(raw.usage?.five_hour?.utilization)){
    relevant.push({label:"five_hour",remaining:left(raw.usage.five_hour.utilization),resetsAt:Date.parse(raw.usage.five_hour.resets_at)});
  }
  if(!relevant.length)return null;
  const exhausted=relevant.filter(w=>w.remaining===0);
  if(exhausted.some(w=>!Number.isSafeInteger(w.resetsAt) || w.resetsAt!<=now))return null;
  return {accountKey:createHash("sha256").update(provider+"\n"+quota.account.toLowerCase()).digest("hex"),notBefore:exhausted.length?Math.max(...exhausted.map(w=>w.resetsAt!)):undefined};
}

export function claudeQuotaError(status: number) {
  if (status === 401)
    return "Claude 인증이 만료되었거나 유효하지 않습니다. CLI 로그인 상태를 확인해주세요.";
  if (status === 403)
    return "Claude 사용량 조회가 거부되었습니다(403). 조회 권한을 확인해주세요.";
  if (status === 429) return "Claude 요청 제한입니다. 잠시 후 다시 확인합니다.";
  if (status >= 500)
    return "Claude 사용량 서버에 일시적인 오류가 있습니다. 잠시 후 다시 확인해주세요.";
  return `Claude 사용량을 조회하지 못했습니다(HTTP ${status}).`;
}

// The script runs on the selected host. Credentials never leave that host or appear in stdout.
const remoteMetadata = `import os,json,urllib.request,urllib.error
def read(p):
 try:
  if os.path.getsize(p)>4000000: return {}
  with open(p,encoding='utf-8') as f: return json.load(f)
 except Exception: return {}
def scoped_limit(v):
 s=v.get('scope')
 m=s.get('model') if isinstance(s,dict) else None
 name=m.get('display_name') if isinstance(m,dict) else None
 return {'kind':v.get('kind'),'percent':v.get('percent'),'resets_at':v.get('resets_at'),'scope':{'model':{'display_name':name}}}
mode=MODE
if mode=='models':
 d=read(os.path.join(os.environ.get('CODEX_HOME',os.path.expanduser('~/.codex')),'models_cache.json'))
 print(json.dumps([dict((k,m.get(k)) for k in ('slug','context_window','max_context_window','effective_context_window_percent')) for m in d.get('models',[])][:200]))
elif mode=='identity':
 root=os.environ.get('CLAUDE_CONFIG_DIR')
 account=read(os.path.join(root,'.claude.json') if root else os.path.expanduser('~/.claude.json')).get('oauthAccount',{})
 print(json.dumps({'email':account.get('emailAddress')}))
else:
 root=os.environ.get('CLAUDE_CONFIG_DIR',os.path.expanduser('~/.claude'))
 c=read(os.path.join(root,'.credentials.json')).get('claudeAiOauth',{})
 account=read(os.path.join(root,'.claude.json') if os.environ.get('CLAUDE_CONFIG_DIR') else os.path.expanduser('~/.claude.json')).get('oauthAccount',{})
 out={'plan':c.get('subscriptionType'),'email':account.get('emailAddress')}
 try:
  token=c.get('accessToken')
  if not token:
   out['missingCredential']=True
   raise ValueError('login')
  req=urllib.request.Request('https://api.anthropic.com/api/oauth/usage',headers={'Authorization':'Bearer '+token,'anthropic-beta':'oauth-2025-04-20','User-Agent':'Harbor'})
  with urllib.request.urlopen(req,timeout=10) as r: d=json.loads(r.read(262144))
  out['usage']={k:{'utilization':v.get('utilization'),'resets_at':v.get('resets_at')} for k,v in d.items() if isinstance(v,dict) and (k.startswith('five_hour') or k.startswith('seven_day'))}
  out['usage']['limits']=[scoped_limit(v) for v in d.get('limits',[])[:100] if isinstance(v,dict)] if isinstance(d.get('limits'),list) else []
 except urllib.error.HTTPError as e:
  out['status']=e.code
  if e.code==429: out['retryAfter']=str(e.headers.get('Retry-After',''))[:100]
 except Exception: out['error']='Claude 구독 로그인 또는 서버 연결을 확인해주세요.'
 print(json.dumps(out))`;

async function readJson(path: string) {
  try {
    if ((await stat(path)).size > 4_000_000) return {};
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}
export class HostInsights {
  private readonly claudeSource:ClaudeQuotaSource;
  readonly antigravityQuota:AntigravityQuota;
  private native = new Map<string, AccountQuota>();
  observe(host: HostConfig|string, usage: TerminalUsage) {
    const hostId=typeof host==="string"?host:quotaHostKey(host);
    if (usage.provider === "claude" && usage.accountWindows?.length) {
      if(!usage.accountWindows.some(w=>w.label==="7일 한도"||w.label==="7일 Fable 한도"))return;
      this.native.set(hostId, {
        provider: "claude",
        windows: usage.accountWindows.filter(
          (w) => w.label === "7일 한도" || w.label === "7일 Fable 한도",
        ),
        updatedAt: usage.updatedAt,
        plan: "Claude 구독 · CLI 실시간",
      });
      if (this.native.size > 64)
        this.native.delete(this.native.keys().next().value!);
    }
  }
  private quotas = new Map<
    string,
    { at: number; refreshAfter: number; value: AccountQuota[] }
  >();
  private pending = new Map<string, Promise<AccountQuota[]>>();
  constructor(
    private files: Files,
    private history: History,
    private password: (id: string) => Promise<string | undefined>,
    directory?:string,private control?:typeof claudeUsageControl,
  ) {this.claudeSource=new ClaudeQuotaSource(directory);this.antigravityQuota=new AntigravityQuota(files,password);}
  private claudeRead(host:HostConfig,force:boolean){
    return this.claudeSource.read(host,force,()=>this.metadata(host,"identity"),()=>this.metadata(host,"claude"),
      this.control?async()=>this.control!(host,await this.password(host.id)):undefined,claudeQuota);
  }
  private async metadata(
    host: HostConfig,
    mode: "models" | "claude" | "identity",
  ): Promise<any> {
    if (host.kind === "ssh") {
      await this.password(host.id);
      const program = remoteMetadata.replace("MODE", JSON.stringify(mode));
      const command = `python3 -c ${shellQuote(`exec(${JSON.stringify(program)})`)} >&3`;
      const result = JSON.parse(
        await this.files.researchCommand(
          host,
          `exec 3>&1; exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(command)} >/dev/null`,
        ),
      );
      return result.status
        ? { ...result, error: claudeQuotaError(result.status) }
        : result;
    }
    if (mode === "models") {
      const data = await readJson(
        join(
          process.env.CODEX_HOME || join(homedir(), ".codex"),
          "models_cache.json",
        ),
      );
      return (data.models || []).slice(0, 200).map((m: any) => ({
        slug: m.slug,
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        effective_context_window_percent: m.effective_context_window_percent,
      }));
    }
    const account = (await readJson(join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"))).oauthAccount;
    if(mode==="identity")return {email:account?.emailAddress};
    const credential = (
      await readJson(
        join(
          process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
          ".credentials.json",
        ),
      )
    ).claudeAiOauth;
    if (!credential?.accessToken)
      return {email:account?.emailAddress,missingCredential:true,error:"Claude CLI의 구독 정보를 확인하지 못했습니다."};
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "Harbor",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      return {
        email: account?.emailAddress,
        plan: credential.subscriptionType,
        error: claudeQuotaError(response.status),
        status:response.status,
        retryAfter:retryAfterSeconds(response.headers.get("retry-after")),
      };
    const body = await response.text();
    if (body.length > 262144) throw new Error("Usage response exceeded limit");
    return {
      usage: JSON.parse(body),
      email: account?.emailAddress,
      plan: credential.subscriptionType,
    };
  }
  quota(host: HostConfig, force = false): Promise<AccountQuota[]> {
    const key = quotaHostKey(host);
    const previous = this.quotas.get(key);
    const native = this.native.get(key) || this.native.get(host.id);
    const recent = native && Date.now() - native.updatedAt < 300000
      ? {...native,windows:native.windows.filter(w=>!w.resetsAt||w.resetsAt>Date.now())}
      : undefined;
    const mergeNative = (q: AccountQuota): AccountQuota => {
      if(q.provider==="claude" && q.stale)q={...q,windows:q.windows.filter(w=>!w.resetsAt||w.resetsAt>Date.now())};
      if (q.provider !== "claude" || !recent?.windows.length) return q;
      const windows = [...q.windows];
      for (const w of recent.windows) {
        const index = windows.findIndex((old) => old.label === w.label);
        if (index < 0) windows.push(w);
        else windows[index] = w;
      }
      return {
        ...q,
        windows,
        updatedAt: !q.windows.length || recent.windows.length===2 ? recent.updatedAt : q.stale?q.updatedAt:Math.max(q.updatedAt,recent.updatedAt),
        ...(q.error && !q.windows.length ? {error:q.retryAt?"나머지 한도는 요청 제한 해제 후 확인합니다.":"나머지 한도는 아직 확인되지 않았습니다.", stale:false, plan:"Claude 구독 · CLI 실시간"}:{}),
        ...(recent.windows.length === 2
          ? { error: undefined, stale: false, retryAt: undefined }
          : {}),
      };
    };
    if (
      previous &&
      previous.at > Date.now() &&
      (!force || previous.refreshAfter > Date.now())
    )
      return Promise.resolve(previous.value.map(mergeNative));
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = (async () => {
      const retry = 120000;
      const refreshDelay = 15000;
      const value = await Promise.all(
        (["codex", "claude"] as const).map(async (provider) => {
          if (provider === "claude" && recent?.windows.length === 2)
            return mergeNative(
              previous?.value.find((q) => q.provider === "claude") || recent,
            );
          try {
            const raw =
              provider === "codex"
                ? await this.history.accountUsage(
                    host,
                    await this.password(host.id),
                  )
                : await this.claudeRead(host,force);
            if(provider==="claude" && raw.retryAt && raw.error){
              return {...(raw.cached||claudeQuota(raw)),provider,account:raw.email,plan:raw.plan||raw.cached?.plan,error:raw.error,stale:!!raw.cached,retryAt:raw.retryAt};
            }
            if(provider==="claude" && raw.cached && raw.error)return {...raw.cached,provider,account:raw.email,stale:true,error:raw.error};
            const result =
              provider === "codex" ? codexQuota(raw) : claudeQuota(raw);
            const old = previous?.value.find((q) => q.provider === provider);
            return provider==="codex" && result.error && old?.windows.length
              ? { ...old, stale: true, error: result.error }
              : result;
          } catch {
            const old = provider==="codex"?previous?.value.find((q) => q.provider === provider):undefined;
            return {
              ...(old || { provider, windows: [], updatedAt: Date.now() }),
              stale: true,
              error:
                "계정 사용량을 읽지 못했습니다. 해당 서버의 CLI 로그인과 연결을 확인해주세요.",
            };
          }
        }),
      );
      this.quotas.set(key, {
        at: Date.now() + retry,
        refreshAfter: Date.now() + refreshDelay,
        value,
      });
      // Bound caches when hosts are edited or removed.
      if (this.quotas.size > 64)
        this.quotas.delete(this.quotas.keys().next().value!);
      return value.map(mergeNative);
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  private reservationMeasurements=new Map<string,{until:number;result:Promise<ReturnType<typeof reservationLimit>>}>();
  reservationQuota(host:HostConfig, provider:"codex"|"claude",model:string, fresh=false){
    const key=JSON.stringify([host,provider,model]), prev=this.reservationMeasurements.get(key);
    if(!fresh && prev && prev.until>Date.now())return prev.result;
    const result=(async()=>{try{
      const raw=provider==="codex" ? await this.history.accountUsage(host,await this.password(host.id)) : await this.claudeRead(host,true);
      return reservationLimit(provider,raw,model);
    }catch{return null;}})();
    this.reservationMeasurements.set(key,{until:Date.now()+120000,result});
    if(this.reservationMeasurements.size>64)this.reservationMeasurements.delete(this.reservationMeasurements.keys().next().value!);
    return result;
  }
  async context(host: HostConfig): Promise<CodexContextSettings> {
    const config = await this.history.contextConfig(
      host,
      await this.password(host.id),
    );
    const profile =
      typeof config.profile === "string" ? config.profile : undefined;
    const effective = {
      ...config,
      ...(profile ? config.profiles?.[profile] : {}),
    };
    const models = await this.metadata(host, "models");
    const model = models.find((m: any) => m.slug === effective.model);
    const customProvider =
      effective.model_provider && effective.model_provider !== "openai";
    const maximum =
      !customProvider && numeric(model?.max_context_window)
        ? model.max_context_window
        : null;
    const current = numeric(effective.model_context_window)
      ? maximum
        ? Math.min(maximum, effective.model_context_window)
        : effective.model_context_window
      : numeric(model?.context_window)
        ? model.context_window
        : null;
    const usablePercent =
      !customProvider &&
      numeric(model?.effective_context_window_percent) &&
      model.effective_context_window_percent > 0 &&
      model.effective_context_window_percent <= 100
        ? model.effective_context_window_percent
        : null;
    return {
      model: text(effective.model) || "CLI 기본 모델",
      current,
      usablePercent,
      usable:
        current && usablePercent
          ? Math.floor((current * usablePercent) / 100)
          : null,
      maximum,
      compactAt: numeric(effective.model_auto_compact_token_limit)
        ? effective.model_auto_compact_token_limit
        : null,
      postTurnPercent: numeric(
        effective.model_post_turn_compact_threshold_percent,
      )
        ? effective.model_post_turn_compact_threshold_percent
        : null,
      profile,
      customProvider: !!customProvider,
    };
  }
  async configure(host: HostConfig, action: "expand" | "compact") {
    const current = await this.context(host);
    if (current.profile && !/^[a-zA-Z0-9_-]+$/.test(current.profile))
      throw new Error("이 프로필 이름은 CLI 설정에서 직접 수정해주세요.");
    const prefix = current.profile ? `profiles.${current.profile}.` : "";
    const window = action === "expand" ? current.maximum : current.current;
    if (!window || current.customProvider)
      throw new Error(
        "선택한 모델의 지원 컨텍스트를 확인할 수 없습니다. 해당 서버에서 Codex를 한 번 실행해주세요.",
      );
    const edits =
      action === "expand"
        ? [{ keyPath: prefix + "model_context_window", value: window }]
        : [
            {
              keyPath: prefix + "model_auto_compact_token_limit",
              value: Math.floor(window * 0.9),
            },
            {
              keyPath: prefix + "model_post_turn_compact_threshold_percent",
              value: 85,
            },
          ];
    await this.history.writeContextConfig(
      host,
      await this.password(host.id),
      edits,
    );
    return this.context(host);
  }
}
export function createInsightsRouter(
  insights: HostInsights,
  host: (id: string) => HostConfig,
) {
  const router = Router();
  router.get("/:id/account-usage", async (req, res) =>
    res.json({
      accounts: await insights.quota(
        host(String(req.params.id)),
        req.query.refresh === "1",
      ),
    }),
  );
  router.get("/:id/antigravity-quota",async(req,res)=>res.json(await insights.antigravityQuota.read(host(String(req.params.id)),req.query.refresh==="1")));
  router.get("/:id/codex-context", async (req, res) =>
    res.json(await insights.context(host(String(req.params.id)))),
  );
  router.post("/:id/codex-context", async (req, res) => {
    const { action } = z
      .object({ action: z.enum(["expand", "compact"]) })
      .strict()
      .parse(req.body);
    res.json(await insights.configure(host(String(req.params.id)), action));
  });
  return router;
}
