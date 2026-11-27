/** Copy only CLI activity headings from the visible user's turn. A redraw
 * without its owning question cannot overwrite a previously captured list. */
export function agyWorkSummary(lines: readonly string[], end: number, question: string) {
  const floor = Math.max(0, end - 400);
  let start = end - 1;
  while (start >= floor && !/^\s*>\s+\S/.test(lines[start])) start--;
  if (start < floor || lines[start].trim().slice(1).trim() !== question.trim()) return;
  const rows: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const text = lines[i].trim();
    const thought = /^[○◯▸▹▴▾▶]\s+(Thought for [\d.hms ]+(?:, [\d,.kKM]+ tokens)?)/.exec(text);
    if (thought) rows.push(thought[1].trim());
    else if (/^(?:[●•]\s+(?:Ran|Explored|Edited|Read|Wrote|Checked|Killed|Searched)\b|…\s*\d+ more actions\b)/i.test(text))
      rows.push(text.replace(/\s*\(ctrl\+o to expand\)\s*$/i,"").slice(0,1024));
  }
  return rows.length ? rows.slice(-80) : undefined;
}
