import { randomUUID } from "node:crypto";
import type { Hub } from "./hub.js";
import { createClaudeChatFactory } from "./ide-chat-claude.js";
import { geminiReview } from "./lab-gemini.js";
import type { LabRunner } from "./lab-questions.js";

export function labRunner(
  hub: Hub,
  passwordFor: (id: string) => Promise<string | undefined>,
  resolveCwd: (hostId: string, path: string) => Promise<string>,
): LabRunner {
  const claude = createClaudeChatFactory();
  return async (member, text, signal) => {
    const host = hub.host(member.hostId);
    const password = await passwordFor(host.id);
    signal.throwIfAborted();
    if (member.provider === "antigravity")
      return geminiReview(host, password, member.model, text, signal);
    const cwd = await resolveCwd(host.id, host.defaultCwd || "~");
    signal.throwIfAborted();
    if (member.provider === "codex") {
      await hub.connect(host.id, password);
      signal.throwIfAborted();
      const session = await hub.createSession(host.id, {
        title: "연구실 · " + text.split("질문\n\n")[1]?.slice(0, 48),
        cwd,
        model: member.model,
        permission: "read-only",
      });
      const jobId = randomUUID();
      session.jobId = jobId;
      try {
        const answer = await hub.runAndWait(
          session.id,
          text,
          jobId,
          signal,
          true,
        );
        return {
          text: answer,
          nativeId: session.threadId,
          model: session.model || undefined,
        };
      } finally {
        if (session.jobId === jobId) delete session.jobId;
      }
    }
    const answers = new Map<string, string>();
    const nativeId = randomUUID();
    let actualModel: string | undefined;
    const run = claude({
      host,
      password,
      cwd,
      model: member.model,
      requestId: randomUUID(),
      nativeId,
      resume: false,
      text,
      reviewOnly: true,
      beforeDispatch: () => signal.throwIfAborted(),
      events: {
        item(item) {
          if (item.kind === "assistant") answers.set(item.id, item.text);
        },
        native(id, model) {
          if (id !== nativeId) throw Error("Claude 대화 ID가 바뀌었습니다.");
          if (model) actualModel = model;
        },
        removeApproval() {},
        approval: async () => ({ approved: false }),
      },
    });
    const cancel = () => run.close();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await run.done;
      signal.throwIfAborted();
      return {
        text: [...answers.values()].join("\n\n"),
        nativeId,
        model: actualModel,
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}
