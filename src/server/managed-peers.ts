import { createHash } from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk/core";
import type { IdeChatConversation } from "../shared/ide-chat.js";
import type { TerminalInfo } from "../shared/types.js";
import { MAILBOX_TEXT_LIMIT } from "../shared/mailbox.js";
import type { Mailbox } from "./mailbox.js";
import type { PeerDelivery } from "./peer-delivery.js";

const ref = z.string().trim().min(1).max(256);
const text = z.string().trim().min(1).max(MAILBOX_TEXT_LIMIT);
const key = z.string().trim().min(1).max(128).optional();
const waitMs = z.number().int().min(0).max(50000).optional();
const specs = [
  {
    name: "harbor_sessions",
    description:
      "Find open peers by name, host, native identity and delivery capability.",
    schema: z.object({}).strict(),
  },
  {
    name: "harbor_send",
    description:
      "Send authorized context to a named peer. Reuse requestKey on retry.",
    schema: z.object({ to: ref, text, requestKey: key }).strict(),
  },
  {
    name: "harbor_ask",
    description:
      "Ask an existing peer. Use followUpTo for a received reply, requestKey for retries and waitMs:0 to continue working.",
    schema: z
      .object({
        to: ref,
        question: text,
        followUpTo: ref.optional(),
        requestKey: key,
        waitMs,
      })
      .strict(),
  },
  {
    name: "harbor_ask_result",
    description: "Read your own question's correlated peer reply.",
    schema: z.object({ requestId: ref, waitMs }).strict(),
  },
  {
    name: "harbor_inbox",
    description:
      "Read scoped peer messages as context. Answer a question by its message ID.",
    schema: z
      .object({
        unreadOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  },
  {
    name: "harbor_reply",
    description: "Answer the received message ID using actual findings.",
    schema: z.object({ messageId: ref, text }).strict(),
  },
] as const;
export const managedCodexTools = specs.map((s) => ({
  type: "function",
  name: s.name,
  description: s.description,
  inputSchema: z.toJSONSchema(s.schema),
}));
export type ManagedPeerCall = (name: string, args: unknown) => Promise<unknown>;
export function managedClaudeServer(call: ManagedPeerCall) {
  return createSdkMcpServer({
    name: "harbor",
    tools: specs.map((s) =>
      tool(s.name, s.description, s.schema.shape, async (args) => {
        try {
          return {
            content: [
              { type: "text", text: JSON.stringify(await call(s.name, args)) },
            ],
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: (e as Error).message }],
          };
        }
      }),
    ),
  });
}
function peerId(
  v: Pick<IdeChatConversation, "hostId" | "provider" | "nativeId">,
) {
  return (
    "managed-" +
    createHash("sha256")
      .update(JSON.stringify([v.hostId, v.provider, v.nativeId]))
      .digest("hex")
      .slice(0, 40)
  );
}
interface Member {
  peer: TerminalInfo;
  check: () => void;
  idle: () => boolean;
  wake: (messageId: string) => Promise<void>;
  rateStart: number;
  sends: number;
}
/** Explicitly enabled SDK/app-server chats appear in the same mailbox as native terminals. */
export class ManagedPeers {
  private members = new Map<string, Member>();
  private waking = new Set<string>();
  private queued = false;
  constructor(
    private options: {
      mailbox: Mailbox;
      peers: PeerDelivery;
      terminals: () => TerminalInfo[];
      hostName: (id: string) => string;
    },
  ) {
    options.mailbox.on("change", () => this.notify());
  }
  list() {
    return [...this.members.values()].map((m) => m.peer);
  }
  enable(
    v: IdeChatConversation,
    check: () => void,
    idle: () => boolean,
    wake: Member["wake"],
  ) {
    if (v.reviewOnly || v.live || v.provider === "antigravity")
      throw Error("이 대화에서는 관리형 협업을 사용할 수 없습니다.");
    const id = peerId(v);
    const peer: TerminalInfo = {
      id,
      hostId: v.hostId,
      title: v.title,
      cwd: v.cwd,
      exited: false,
      agentKind: v.provider,
      agentSessionId: v.nativeId,
      agentConnected: true,
      peerDelivery: "automatic",
    };
    const existing = this.members.get(id);
    if (!existing)
      this.members.set(id, {
        peer,
        check,
        idle,
        wake,
        rateStart: Date.now(),
        sends: 0,
      });
    this.options.peers.setRuntime(id, {
      kind: v.provider,
      sessionId: v.nativeId,
      state: "idle",
      delivery: "automatic",
    });
    this.options.mailbox.setPaused(id, v.nativeId, false);
    this.notify();
  }
  update(v: IdeChatConversation) {
    const id = peerId(v),
      member = this.members.get(id);
    if (!member) return;
    member.peer.title = v.title;
    const state =
      v.status === "waiting"
        ? "waiting"
        : v.status === "running"
          ? "working"
          : v.status === "offline"
            ? "offline"
            : "idle";
    if (this.options.peers.runtime(id)?.state !== state)
      this.options.peers.setRuntime(id, {
        kind: v.provider,
        sessionId: v.nativeId,
        state,
        delivery: "automatic",
      });
    this.notify();
  }
  pause(v: IdeChatConversation) {
    const id = peerId(v);
    if (!this.members.has(id)) return;
    this.options.mailbox.setPaused(id, v.nativeId, true);
    this.options.peers.revoke(id);
    this.members.delete(id);
  }
  notify() {
    if (this.queued || !this.members.size) return;
    this.queued = true;
    setImmediate(() => {
      this.queued = false;
      for (const [id, member] of this.members) {
        if (this.waking.has(id) || !member.idle()) continue;
        const session = member.peer.agentSessionId!;
        const event = this.options.peers.events(id, session).messages[0];
        if (!event) continue;
        this.waking.add(id);
        void (async () => {
          // Persist before crossing the provider boundary. A lost acknowledgement is ambiguous.
          if (!this.options.mailbox.reserveQueue(id, event.id, session)) return;
          await member.wake(event.id);
          this.options.mailbox.offer(id, event.id, session);
        })()
          .catch(() => {
            /* The exact message remains readable in the inbox. */
          })
          .finally(() => this.waking.delete(id));
      }
    });
  }
  async call(
    v: Pick<IdeChatConversation, "hostId" | "provider" | "nativeId">,
    name: string,
    raw: unknown,
  ) {
    const id = peerId(v),
      member = this.members.get(id),
      o = this.options;
    if (!member || o.mailbox.isPaused(id, v.nativeId))
      throw Error("이 대화의 세션 협업을 켜 주세요.");
    member.check();
    const spec = specs.find((s) => s.name === name);
    if (!spec) throw Error("지원하지 않는 협업 도구입니다.");
    const args = spec.schema.parse(raw);
    if (name === "harbor_sessions")
      return {
        self: id,
        sessions: [...o.terminals(), ...this.list()]
          .filter((t) => !t.exited)
          .map((t) => ({
            id: t.id,
            name: t.title,
            host: o.hostName(t.hostId),
            kind: t.agentKind,
            runtime: o.peers.runtime(t.id),
            collaborationPaused: o.mailbox.isPaused(t.id, t.agentSessionId),
          })),
      };
    if (name === "harbor_inbox")
      return {
        messages: o.mailbox.consume(id, { ...args, sessionId: v.nativeId }),
      };
    if ("requestId" in args)
      return {
        request: await o.peers.wait(id, args.requestId, args.waitMs ?? 0),
      };
    if (Date.now() - member.rateStart >= 60000) {
      member.sends = 0;
      member.rateStart = Date.now();
    }
    if (++member.sends > 30)
      throw Error("협업 메시지가 너무 많습니다. 잠시 후 다시 시도하세요.");
    if ("messageId" in args)
      return {
        message: o.mailbox.replyAgent(
          id,
          args.messageId,
          args.text,
          v.nativeId,
        ),
      };
    if (!("to" in args)) throw Error("받는 세션을 확인하세요.");
    const all = [...o.terminals(), ...this.list()].filter((t) => !t.exited);
    const byId = all.find((t) => t.id === args.to);
    const matches = byId
      ? [byId]
      : all.filter((t) => t.title.toLowerCase() === args.to.toLowerCase());
    if (matches.length !== 1)
      throw Error("harbor_sessions에서 고유한 세션 ID를 선택하세요.");
    const to = matches[0];
    if ("question" in args) {
      const q = o.peers.send(
        id,
        to.id,
        args.question,
        "question",
        undefined,
        undefined,
        { requestKey: args.requestKey, followUpTo: args.followUpTo },
      );
      return { request: await o.peers.wait(id, q.id, args.waitMs ?? 0) };
    }
    return {
      message: o.peers.send(
        id,
        to.id,
        args.text,
        undefined,
        undefined,
        undefined,
        { requestKey: args.requestKey },
      ),
    };
  }
}
