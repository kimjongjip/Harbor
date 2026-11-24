import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { HostConfig } from "../shared/types.js";
import type { RemoteWorkspaces } from "./remote-workspaces.js";
import type { IdeChatUsage } from "../shared/ide-chat.js";
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
    for (const k of ["provider", "cursor", "query"]) {
      const value = req.query[k];
      if (typeof value === "string") params.set(k, value);
    }
    return { path: "/hosts/local/history?" + params, body: undefined };
  }
  if (req.method === "POST" && req.path === "/conversations") {
    if (req.body?.hostId !== hostId) deny("다른 서버의 대화 요청입니다.");
    return { path: req.path, body: { ...req.body, hostId: "local" } };
  }
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
  if(req.method==="POST" && /^\/conversations\/[a-f0-9-]{36}\/settings$/i.test(req.path))return {path:req.path,body:req.body};
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
) {
  const router = Router({ mergeParams: true });
  // Only metadata is retained. Old workers support conditional conversation
  // reads, allowing an authorization/binding check without replaying messages.
  const bindings = new Map<string, LegacyRow>();
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
    const { path, body } = relayChatRequest(id, req);
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
      },
    );
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
