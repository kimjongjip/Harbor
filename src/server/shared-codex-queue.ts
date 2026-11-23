import type { Duplex } from "node:stream";
import type { MailboxMessage } from "../shared/mailbox.js";
import { codexPeerPrompt } from "./codex-peer-runtime.js";
import { RpcClient, RpcRequestRejected } from "./rpc.js";

/** A proxy carries input to the already loaded thread. It owns no terminal or turn. */
export async function queueSharedCodexMessages(options: {
  sessionId: string;
  messages: MailboxMessage[];
  connect(): Promise<Duplex>;
  reserve(messageId: string): boolean;
  accepted(messageId: string): void;
  rejected(messageId: string): void;
}) {
  const { sessionId } = options;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)) return;
  const rpc = new RpcClient();
  try {
    await rpc.startProxy(await options.connect());
    const { thread } = await rpc.call("thread/read", {
      threadId: sessionId,
      includeTurns: false,
    });
    if (
      thread?.id !== sessionId ||
      !["active", "idle"].includes(thread.status?.type) ||
      thread.parentThreadId ||
      thread.ephemeral ||
      thread.source?.subAgent ||
      (thread.threadSource != null && thread.threadSource !== "user")
    )
      throw new Error("공유 대화가 실행 중인지 확인하세요.");
    for (const message of options.messages) {
      if (
        message.recipient.sessionId !== sessionId ||
        !options.reserve(message.id)
      )
        continue;
      try {
        await rpc.call("thread/queue/add", {
          threadId: sessionId,
          input: [
            { type: "text", text: codexPeerPrompt(message), text_elements: [] },
          ],
          clientUserMessageId: "harbor-peer-" + message.id,
        });
      } catch (error) {
        if (error instanceof RpcRequestRejected) options.rejected(message.id);
        throw error;
      }
      options.accepted(message.id);
    }
  } finally {
    rpc.stop();
  }
}
