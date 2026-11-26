import { useEffect, useState } from "react";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import type { MobileConversationPage } from "../../shared/mobile";

const empty: RichTerminalBlock[] = [];

// A resumed CLI may have saved messages but no rich-terminal reservations.
export function useMobileHistoryAnswers(key: string, terminal: string, session: string | undefined,
  active: boolean, completion: string | undefined, idle: boolean) {
  const [saved, setSaved] = useState({key:"", blocks:empty});
  useEffect(() => {
    if (!active || !session || !terminal) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    async function read() {
      if (busy || controller.signal.aborted || document.hidden) return;
      busy = true;
      clearTimeout(timer);
      try {
        const url = "/mobile-api/terminals/"+encodeURIComponent(terminal)+"/conversation?sessionId="+encodeURIComponent(session!);
        const response = await fetch(url, {credentials:"same-origin", signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
        if (!response.ok) return;
        const page: MobileConversationPage = await response.json();
        if (controller.signal.aborted || page.sessionId !== session || !Array.isArray(page.items)) return;
        const blocks: RichTerminalBlock[] = [];
        let size = 0;
        for (const item of [...page.items].reverse()) {
          if (item.kind !== "assistant" || !item.text || (item.turnStatus && item.turnStatus !== "completed") || item.phase === "commentary") continue;
          if (item.text.length > 262144) continue;
          size += item.text.length;
          if (blocks.length >= 16 || size > 524288) break;
          blocks.push({id:"history:"+page.provider+":"+item.id,sessionId:page.sessionId,requestId:item.id,
            text:item.text,placement:"card",marker:"",state:"ready",columns:0,viewportRows:0,createdAt:0});
        }
        blocks.reverse();
        setSaved(old=>old.key===key && old.blocks.length===blocks.length &&
          old.blocks.every((b,i)=>b.id===blocks[i].id && b.text===blocks[i].text) ? old : {key,blocks});
      } catch {
        // The native stream remains usable while the history connection recovers.
      } finally {
        busy = false;
        if (!controller.signal.aborted) timer = setTimeout(read,30000);
      }
    }
    void read();
    document.addEventListener("visibilitychange", read);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", read); };
  },[key,terminal,session,active,completion,idle]);
  return saved.key===key ? saved.blocks : empty;
}
