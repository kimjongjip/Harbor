/** AgY paints the submitted prompt and a Braille spinner before the new composer. */
export function agyGeneratingRow(lines: readonly string[], end: number, baseY: number) {
  for (let i = end - 1; i >= Math.max(baseY, end - 32); i--)
    if (/^\s*[\u2800-\u28ff·●○◌*✦✧⏳]*\s*Generating(?:\.{1,3}|…)?\s*$/iu.test(lines[i])) return i;
  return -1;
}

/** Decode only the AgY status strip below the composer's closing rule. */
export function agyStatusFooter(lines: readonly string[], end = lines.length) {
  let bottom = end;
  while (bottom > Math.max(0, end - 8) && !lines[bottom - 1].trim()) bottom--;
  let rule = bottom - 1;
  while (rule >= Math.max(0, bottom - 5) && !/^\s*[─━]{8,}\s*$/.test(lines[rule])) rule--;
  if (rule < Math.max(0, bottom - 5)) return;
  const text = lines.slice(rule + 1, bottom).map(line => line.trim()).join(" ");
  const match = /^(?:(esc to cancel|\? for shortcuts)\s+)?(auto|plan|default|manual|turbo|accept-edits)\s*·\s*([^·]+?)\s*·\s*([\w-]+)(\s*·.*)?$/i.exec(text);
  if (match) return { start: rule + 1, hint: match[1], mode: match[2], model: match[3].trim(), effort: match[4], extra: match[5]?.trim() };
}
