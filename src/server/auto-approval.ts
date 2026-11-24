import type { TerminalInfo } from "../shared/types.js";
import type { HarborRequest } from "../shared/requests.js";
import type { Requests } from "./requests.js";

type State = NonNullable<TerminalInfo["autoApproval"]>;

/** Answers real native PermissionRequest events. Never reads PTY text or types Enter. */
export class AutoApproval {
  private policies = new Map<string, State>();
  private draining = false;
  private readonly checked = new WeakMap<State, Set<string>>();
  constructor(
    private readonly requests: Requests,
    private readonly terminal: (id: string) => TerminalInfo | undefined,
    private readonly changed: () => void,
    private readonly workspaceCheck?: (
      terminal: TerminalInfo,
      request: HarborRequest,
    ) => Promise<boolean>,
  ) {
    requests.on("change", this.refresh);
  }
  state(id: string): State {
    return { ...(this.policies.get(id) || { enabled: false, accepted: 0 }) };
  }
  set(id: string, enabled: boolean, workspaceOnly = false) {
    const terminal = this.terminal(id);
    if (!terminal || terminal.exited)
      throw new Error("실행 중인 터미널을 찾을 수 없습니다.");
    if (enabled && terminal.integration !== "ready")
      throw new Error(
        "이 터미널에는 Harbor 승인 요청 연결이 없습니다. 관리형 터미널로 다시 연결하세요.",
      );
    const previous = this.policies.get(id);
    this.policies.set(id, {
      enabled,
      ...(workspaceOnly && enabled ? { workspaceOnly: true } : {}),
      accepted: previous?.accepted || 0,
      ...(previous?.lastAcceptedAt
        ? { lastAcceptedAt: previous.lastAcceptedAt }
        : {}),
      ...(terminal.agentSessionId
        ? { sessionId: terminal.agentSessionId }
        : {}),
    });
    if (enabled && workspaceOnly)
      this.checked.set(this.policies.get(id)!, new Set());
    this.refresh();
    this.changed();
    return this.state(id);
  }
  private async acceptWorkspaceRequest(
    terminal: TerminalInfo,
    policy: State,
    request: HarborRequest,
  ) {
    const { id, hostId, agentKind, cwd, agentSessionId } = terminal;
    try {
      if (
        !this.workspaceCheck ||
        !(await this.workspaceCheck(terminal, request))
      )
        return;
      const now = this.terminal(id);
      if (
        this.policies.get(id) !== policy ||
        !policy.enabled ||
        !now ||
        now.exited ||
        !now.agentConnected ||
        now.integration !== "ready" ||
        now.hostId !== hostId ||
        now.cwd !== cwd ||
        now.agentKind !== agentKind ||
        now.agentSessionId !== agentSessionId ||
        this.requests.result(id, request.id, false).status !== "pending"
      )
        return;
      this.requests.acceptAutomatically(request.id);
      policy.accepted++;
      policy.lastAcceptedAt = Date.now();
      this.changed();
    } catch {
      // Failed scope checks or a superseded request leave the ordinary approval flow in charge.
    }
  }
  refresh = () => {
    if (this.draining) return;
    this.draining = true;
    let changed = false;
    let requests: HarborRequest[] | undefined;
    try {
      for (const [id, policy] of this.policies) {
        const terminal = this.terminal(id);
        if (!terminal || terminal.exited) {
          this.policies.delete(id);
          changed = true;
          continue;
        }
        if (!policy.enabled) continue;
        const sessionId = terminal.agentSessionId;
        if (!sessionId) continue;
        if (policy.sessionId && policy.sessionId !== sessionId) {
          policy.enabled = false;
          policy.detail =
            "대화가 변경되어 자동 수락을 껐습니다. 이 대화에 적용하려면 다시 켜세요.";
          changed = true;
          continue;
        }
        if (!policy.sessionId) {
          policy.sessionId = sessionId;
          changed = true;
        }
        requests ??= this.requests.list();
        const pending = requests.filter(
          (r) => r.status === "pending" && r.terminal.terminalId === id,
        );
        const checked = this.checked.get(policy);
        if (checked)
          for (const key of checked)
            if (!pending.some((r) => r.id === key)) checked.delete(key);
        for (const request of pending) {
          if (
            !policy.enabled ||
            request.kind !== "permission" ||
            request.permission?.sessionId !== sessionId
          )
            continue;
          // Task questions / plan decisions are not execution permissions, even
          // when a CLI represents them as a permission-hook event.
          if (
            /(?:^|__)(?:AskUserQuestion|ExitPlanMode|EnterPlanMode|request_user_input|harbor_request)$/i.test(
              request.permission.toolName,
            )
          )
            continue;
          if (checked) {
            if (!checked.has(request.id)) {
              checked.add(request.id);
              void this.acceptWorkspaceRequest(terminal, policy, request);
            }
            continue;
          }
          try {
            this.requests.acceptAutomatically(request.id);
            policy.accepted++;
            policy.lastAcceptedAt = Date.now();
            changed = true;
          } catch {
            policy.enabled = false;
            policy.detail =
              "승인 응답을 저장하지 못해 자동 수락을 껐습니다. 받은함에서 요청을 확인하세요.";
            changed = true;
            break;
          }
        }
      }
    } finally {
      this.draining = false;
      if (changed) this.changed();
    }
  };
  dispose() {
    this.requests.off("change", this.refresh);
    this.policies.clear();
  }
}
