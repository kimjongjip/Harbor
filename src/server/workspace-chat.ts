import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { HostConfig } from "../shared/types.js";
import type { RemoteWorkspaces } from "./remote-workspaces.js";

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
) {
  const router = Router({ mergeParams: true });
  router.use(async (req, res) => {
    const id = String(req.params.hostId),
      destination = host(id);
    if (destination.kind !== "ssh" || !workspaces.enabled(destination))
      deny("이 서버의 세션 유지 연결을 확인하세요.", 409);
    const guard = () => {
      const now = host(id);
      if (
        now.address !== destination.address ||
        now.username !== destination.username ||
        now.port !== destination.port ||
        now.identityFile !== destination.identityFile
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
    const result = await workspaces.chat(
      destination,
      await password(id),
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
