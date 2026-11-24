import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { HostConfig } from "../shared/types.js";
import type { RemoteWorkspaces } from "./remote-workspaces.js";
import type { IdeChatUsage } from "../shared/ide-chat.js";
import type { HistoryDetail, HistoryPage, HistoryThread } from "../shared/history.js";
import { WorkspaceActivity, type ActivityView } from "./workspace-activity.js";
import { visibleHistoryPage } from "./history-visibility.js";
import { z } from "zod";

const legacyBinding = z.object({
  id: z.string().uuid(),
  hostId: z.literal("local"),
  runtimeId: z.string().uuid(),
  nativeId: z.string().uuid(),
  provider: z.enum(["codex", "claude", "antigravity"]),
  cwd: z
    .string()
    .regex(/^\/[^\0\r\n]*$/)
    .max(4096),
  contentRevision: z.number().int().nonnegative().optional(),
});
type Binding = z.infer<typeof legacyBinding>;
interface LegacyRow {
  binding: Binding;
  at: number;
}
type LegacyUsage = (
  host: HostConfig,
  binding: Binding,
) => Promise<IdeChatUsage>;

function deny(message: string, status = 403): never {
  throw Object.assign(Error(message), { status });
}

export function relayChatRequest(
  hostId: string,
  req: Pick<Request, "method" | "path" | "query" | "body">,
) {
  if (
    /^\/lab-questions(?:\/[a-f0-9-]{36})?$/.test(req.path) &&
    ["GET", "POST"].includes(req.method)
  ) {
    if (req.method === "POST" && req.path === "/lab-questions") {
      const members = req.body?.members;
      if (
        !Array.isArray(members) ||
        !members.length ||
        members.some((m) => m?.hostId !== hostId)
      )
        deny("같은 서버의 참여자를 선택하세요.");
      return {
        path: req.path,
        body: {
          ...req.body,
          members: members.map((m) => ({ ...m, hostId: "local" })),
        },
      };
    }
    return {
      path: req.path,
      body: req.method === "POST" ? req.body : undefined,
    };
  }
  if (
    req.method === "GET" &&
    req.path === "/hosts/" + encodeURIComponent(hostId) + "/history"
  ) {
    const params = new URLSearchParams();
    for (const k of ["provider", "cursor", "query", "cwd"]) {
      if (k==="cwd" && req.query.provider!=="codex") continue;
      const value = req.query[k];
      if (typeof value === "string") params.set(k, value);
    }
    return { path: "/hosts/local/history?" + params, body: undefined };
  }
  if (req.method === "POST" && req.path === "/conversations") {
    if (req.body?.hostId !== hostId) deny("다른 서버의 대화 요청입니다.");
    return { path: req.path, body: { ...req.body, hostId: "local" } };
  }
  const hostPath = "/hosts/" + encodeURIComponent(hostId);
  if (req.method === "GET" && req.path === hostPath + "/runtime")
    return {path:"/hosts/local/runtime",body:undefined};
  if (req.method === "POST" && req.path === hostPath + "/reconnect")
    return {path:"/hosts/local/reconnect",body:req.body};
  if (/^\/conversations\/[0-9a-f-]{36}\/worktree$/i.test(req.path)) {
    if (req.method === "POST") return { path: req.path, body: req.body };
    if (req.method === "GET")
      return {
        path:
          req.path +
          (typeof req.query.file === "string"
            ? "?" + new URLSearchParams({ file: req.query.file })
            : ""),
        body: undefined,
      };
    deny("지원하지 않는 Git 요청입니다.", 404);
  }
  if (
    req.method === "GET" &&
    /^\/conversations\/[a-f0-9-]{36}\/usage$/i.test(req.path)
  )
    return { path: req.path, body: undefined };
  if(req.method==="GET" && req.path==="/hosts/"+encodeURIComponent(hostId)+"/models"){
    const provider=z.enum(["codex","claude","antigravity"]).parse(req.query.provider);
    return {path:"/hosts/local/models?"+new URLSearchParams({provider}),body:undefined};
  }
  if (req.method === "POST" && /^\/conversations\/[a-f0-9-]{36}\/(settings|auto-accept)$/i.test(req.path))
    return { path: req.path, body: req.body };
  const pattern =
    /^\/conversations\/[0-9a-f-]{36}(\/(messages|collaboration|interrupt|history|control|rate-reset)|\/(queue|approvals)\/[A-Za-z0-9_:%-]{1,180})?$/i;
  if (
    !["GET", "POST"].includes(req.method) ||
    !pattern.test(req.path) ||
    /%(?!3a)/i.test(req.path)
  )
    deny("지원하지 않는 서버 대화 요청입니다.", 404);
  return { path: req.path, body: req.method === "POST" ? req.body : undefined };
}
export function workspaceChatRouter(
  workspaces: RemoteWorkspaces,
  host: (id: string) => HostConfig,
  password: (id: string) => Promise<string | undefined>,
  authorize: (
    req: Request,
    res: Response,
    id: string,
  ) => { kind: "host" | "desktop" | "mobile"; id: string },
  legacyUsage?: LegacyUsage,
  legacyActivity?: (host:HostConfig,binding:Binding)=>Promise<HistoryDetail>,
  legacyFolderHistory?: (host:HostConfig,options:{cwd:string;cursor?:string;search?:string;managed?:HistoryThread[]})=>Promise<HistoryPage>,
  historyVisible?: (host:HostConfig,provider:"codex"|"claude"|"antigravity",id:string)=>boolean,
) {
  const router = Router({ mergeParams: true });
  // Only metadata is retained. Old workers support conditional conversation
  // reads, allowing an authorization/binding check without replaying messages.
  const bindings = new Map<string, LegacyRow>();
  const activity = new WorkspaceActivity();
  router.use(async (req, res) => {
    const id = String(req.params.hostId),
      destination = { ...host(id) };
    if (destination.kind !== "ssh" || !workspaces.enabled(destination))
      deny("이 서버의 세션 유지 연결을 확인하세요.", 409);
    const guard = () => {
      const now = host(id);
      if (
        now.address !== destination.address ||
        now.username !== destination.username ||
        now.port !== destination.port ||
        now.identityFile !== destination.identityFile ||
        !workspaces.enabled(now)
      )
        deny("서버 설정이 변경되었습니다.", 409);
      return authorize(req, res, id);
    };
    const { kind, id: device } = guard(),
      actor =
        kind +
        "-" +
        createHash("sha256").update(device).digest("hex").slice(0, 32);
    if (req.method === "GET" && req.path === "/workspace-update") {
      res.set("Cache-Control", "no-store").json(workspaces.status(destination));
      return;
    }
    const operation = relayChatRequest(id, req);
    let { path } = operation;
    const folderQuery = req.method === "GET" && req.path === "/hosts/"+encodeURIComponent(id)+"/history" &&
      req.query.provider === "codex" && req.query.cwd !== undefined
      ? z.object({cwd:z.string().min(1).max(4096).regex(/^[^\0\r\n]+$/),cursor:z.string().max(8192).optional(),query:z.string().max(300).optional()}).parse(req.query)
      : undefined;
    const legacyCursor = folderQuery?.cursor?.startsWith("lh1.") ? folderQuery.cursor.slice(4) : undefined;
    if (legacyCursor !== undefined) {
      // This cursor belongs to the PC reader. An older worker still authorizes the ordinary list read.
      const url=new URL(path,"http://workspace.local");
      url.searchParams.delete("cursor");
      path=url.pathname+url.search;
    }
    const scope = createHash("sha256").update(JSON.stringify([
      destination.id, destination.address, destination.port, destination.username, destination.identityFile,
    ])).digest("hex");
    const conversationId = req.method === "GET" && /^\/conversations\/([a-f0-9-]{36})$/i.exec(path)?.[1];
    const activityKey = JSON.stringify([scope,actor,conversationId]);
    const requested = req.get("X-Harbor-Chat-Revision");
    const sameActor = () => {
      const current=guard();
      if(current.kind!==kind || current.id!==device)deny("기기 연결 권한이 변경되었습니다.");
    };
    let body = operation.body;
    if (path === "/hosts/local/reconnect" && body?.reconnectScope !== undefined) {
      if (body.reconnectScope !== scope) deny("서버 계정이 변경되었습니다.", 409);
      // The relay validates its SSH account scope. The worker checks its own runtime and native ID.
      const {reconnectScope, ...rest} = body;
      body = rest;
    }
    const pass = await password(id);
    let result = await workspaces.chat(
      destination,
      pass,
      actor,
      req.method,
      path,
      body,
      req.get("X-Harbor-Terminal"),
      guard,
      {
        client: req.get("X-Harbor-Client"),
        token: req.get("X-Harbor-Control"),
        revision: conversationId ? activity.conditional(activityKey, requested) : undefined,
      },
    );
    if (folderQuery && legacyFolderHistory && result.status===200 && Array.isArray(result.value?.data) &&
        (legacyCursor !== undefined || result.value.preferredCwd !== folderQuery.cwd)) {
      sameActor();
      const managed = result.value.data.filter((t: HistoryThread) => t?.hostId === "local" && t.source === "Harbor IDE")
        .map((t:HistoryThread) => ({...t,provider:"codex" as const,hostId:destination.id}));
      const ranked = await legacyFolderHistory(destination, {
        cwd:folderQuery.cwd, cursor:legacyCursor ?? folderQuery.cursor, search:folderQuery.query, managed,
      });
      sameActor();
      result={status:200,value:{...ranked,nextCursor:ranked.nextCursor ? "lh1."+ranked.nextCursor : null}};
    }
    if (conversationId && legacyActivity && result.status===200 && !result.value?.unchanged) {
      const nativeView=(value:any):ActivityView|undefined=>{
        const binding=legacyBinding.safeParse(value).data;
        if(!binding || binding.id!==conversationId || binding.provider==="antigravity" ||
            value.nativeActivityTimeline===true || !Array.isArray(value.items))return;
        return value;
      };
      const view=nativeView(result.value);
      if(view){
        const binding=legacyBinding.parse(view);
        result.value=await activity.enrich(activityKey,destination.id,view,
          ()=>legacyActivity(destination,binding),
          async()=>{
            sameActor();
            const check=await workspaces.chat(destination,pass,actor,"GET",path,undefined,undefined,sameActor,
              view.contentRevision===undefined?undefined:{revision:view.runtimeId+":"+view.contentRevision});
            if(check.status!==200)deny("서버 대화 연결을 다시 확인하세요.",check.status);
            if(check.value?.unchanged===true && view.contentRevision!==undefined)return;
            const confirmed=nativeView(check.value);
            if(!confirmed)deny("서버 대화의 연결 정보를 확인할 수 없습니다.",409);
            return confirmed;
          },sameActor,requested);
      }else activity.clear(activityKey);
    }else if(conversationId && result.status!==200)activity.clear(activityKey);
    if (result.unsupportedUsage && legacyUsage) {
      const conversationId = path.split("/")[2],
        key = JSON.stringify([
          destination.id,
          destination.address,
          destination.port,
          destination.username,
          destination.identityFile,
          actor,
          conversationId,
        ]);
      const previous = bindings.get(key);
      const cached =
        previous && Date.now() - previous.at < 10000
          ? previous.binding
          : undefined;
      const confirmation = await workspaces.chat(
        destination,
        pass,
        actor,
        "GET",
        "/conversations/" + conversationId,
        undefined,
        undefined,
        guard,
        cached
          ? { revision: cached.runtimeId + ":" + (cached.contentRevision ?? 0) }
          : undefined,
      );
      guard();
      if (confirmation.status !== 200) {
        bindings.delete(key);
        res.status(confirmation.status).json(confirmation.value);
        return;
      }
      const binding =
        confirmation.value?.unchanged === true && cached
          ? cached
          : legacyBinding.safeParse(confirmation.value).data;
      // Drop any replayed items before starting SSH telemetry I/O.
      confirmation.value = undefined;
      if (!binding || binding.id !== conversationId)
        deny("서버 대화의 연결 정보를 확인할 수 없습니다.", 409);
      if (binding !== cached) {
        bindings.delete(key);
        bindings.set(key, { binding, at: Date.now() });
        if (bindings.size > 64) bindings.delete(bindings.keys().next().value!);
      }
      const value =
        binding.provider === "antigravity"
          ? { usage: null, work: null }
          : await legacyUsage(destination, binding);
      guard();
      if (
        value.usage &&
        (value.usage.provider !== binding.provider ||
          value.usage.sessionId !== binding.nativeId)
      )
        deny("서버 사용량의 대화 ID가 달라졌습니다.", 409);
      result = { status: 200, value };
    }
    if (result.status === 200 && result.value?.runtimeId && (path === "/hosts/local/runtime" || result.value?.hostId === "local"))
      result.value.reconnectScope = scope;
    if (historyVisible && result.status === 200 && req.method === "GET" &&
        req.path === "/hosts/" + encodeURIComponent(id) + "/history" && Array.isArray(result.value?.data)) {
      const provider = z.enum(["codex","claude","antigravity"]).default("codex").parse(req.query.provider);
      const keep = (row: {id:string}) => historyVisible(destination, provider, row.id);
      if (req.query.cwd) {
        // Folder pages can carry a cursor issued by the PC for a legacy worker.
        result.value = {...result.value, data:result.value.data.filter(keep)};
      } else {
        const first = result.value;
        const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
        result.value = await visibleHistoryPage(cursor, async next => {
          if (next === cursor) return first;
          sameActor();
          const url = new URL(path,"http://workspace.invalid");
          url.searchParams.set("cursor",next!);
          const following = await workspaces.chat(destination,pass,actor,"GET",
            url.pathname + url.search,undefined,undefined,sameActor);
          sameActor();
          if (following.status !== 200 || !Array.isArray(following.value?.data))
            deny("서버의 대화 기록을 불러올 수 없습니다.",following.status === 200 ? 502 : following.status);
          return following.value;
        },keep);
      }
    }
    if (result.value?.hostId === "local") result.value.hostId = id;
    if (Array.isArray(result.value?.members))
      for (const m of result.value.members)
        if (m.hostId === "local") m.hostId = id;
    if (Array.isArray(result.value?.data))
      for (const row of result.value.data)
        if (row.hostId === "local") row.hostId = id;
    res.status(result.status).json(result.value);
  });
  return router;
}
