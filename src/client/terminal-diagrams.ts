import type { MessageItem } from "../shared/types";

/** Only closed fences from saved messages, never terminal escape sequences. */
export function mermaidFences(text: string): string[] {
  const diagrams: string[] = [];
  let fence:
    | { char: string; length: number; mermaid: boolean; lines: string[] }
    | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!fence) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (open)
        fence = {
          char: open[1][0],
          length: open[1].length,
          mermaid: open[2].trim().toLowerCase() === "mermaid",
          lines: [],
        };
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length
      ) {
        const source = fence.lines.join("\n").trim();
        if (fence.mermaid && source && source.length <= 50000)
          diagrams.push(source);
        fence = undefined;
      } else if (fence.mermaid) fence.lines.push(line);
    }
  }
  return diagrams;
}

export function nativeDiagramUnsupported(lines: string[]): boolean {
  return /thismermaiddiagramusesfeaturestheterminalrendererdoesn['’]tsupport/i.test(
    lines.join("").replace(/\s/g, ""),
  );
}

export function savedDiagrams(items: MessageItem[]) {
  return items
    .flatMap((item) => {
      if (
        item.kind !== "assistant" ||
        (item.phase && item.phase !== "final_answer") ||
        (item.status && !["completed", "complete"].includes(item.status))
      )
        return [];
      return mermaidFences(item.text).map((source, index) => ({
        id: `${item.id}:${index}`,
        source,
      }));
    })
    .slice(-16);
}
