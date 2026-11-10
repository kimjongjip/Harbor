/** A terminal footer is only a reason to reread history, never proof of completion. */
const workedFooter =
  /^\s*(?:(?:[•·*]|[─━]+)\s*)?Worked for\s+\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\s*\d+(?:\.\d+)?(?:ms|s|m|h|d))*(?:\s*[·•]\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?\s*(?:[─━]+)?\s*$/i;
const claudeFooter =
  /^\s*[*✻✢✳✶✽✦✧·]\s+[A-Za-z]+(?: [A-Za-z]+)? for\s+\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s*\d+(?:\.\d+)?(?:ms|s|m|h))*(?:\s*·\s*done(?:\s+.*)?)?\s*$/;

/** Deduplicate the native Codex footer without including the editable prompt below it. */
export class TerminalCompletionCue {
  private initialized = false;
  private previous: string | undefined;

  observe(lines: readonly string[], provider: string = "codex"): boolean {
    // Initial empty frames precede replay. The first populated snapshot is a
    // baseline, already covered by the normal initial history read.
    if (!this.initialized && !lines.some((line) => line.trim())) return false;
    let cue: string | undefined;
    for (
      let row = lines.length - 1;
      row >= Math.max(0, lines.length - 80);
      row--
    ) {
      if (
        !(provider === "claude" ? claudeFooter : workedFooter).test(lines[row])
      )
        continue;
      // A repeated duration can belong to a new answer. Take a bounded visible
      // suffix before the footer, not subsequent cursor/draft/status changes.
      const answer = lines
        .slice(Math.max(0, row - 12), row)
        .join("")
        .replace(/\s+/g, "")
        .slice(-512);
      cue = `${lines[row].trim().replace(/\s+/g, " ")}:${answer}`;
      break;
    }
    const changed =
      this.initialized && cue !== undefined && cue !== this.previous;
    this.initialized = true;
    this.previous = cue;
    return changed;
  }
}
