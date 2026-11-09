/**
 * xterm emits these replies through onData even when nobody types. Recognize
 * only complete, known responses (including concatenated responses), never
 * ordinary keys, paste wrappers, mouse input or arbitrary escape sequences.
 */
export function isTerminalProtocolResponse(data: string): boolean {
  if (!data || data.length > 65536) return false;
  // DA, DSR/CPR, DECRPM, window reports, focus, keyboard-mode reports;
  // OSC palette/default colors; xterm's bounded DECRQSS response forms.
  const response =
    /(?:\x1b\[(?:[?>]\d{1,7}(?:;\d{1,7}){0,16}c|0n|\??\d{1,7};\d{1,7}R|\??\d{1,7};[0-4]\$y|[4689];\d{1,7};\d{1,7}t|[IO]|\?\d{1,7}u|>4;[0-2]m)|\x1b\](?:4;\d{1,3}|1[012]);rgb:[a-fA-F\d]{1,4}\/[a-fA-F\d]{1,4}\/[a-fA-F\d]{1,4}(?:\x07|\x1b\\)|\x1bP(?:0\$r|1\$r(?:[01]"q|61;1"p|\d{1,7};\d{1,7}r|0m|[0-6] q))\x1b\\)/y;
  let offset = 0;
  while (offset < data.length) {
    response.lastIndex = offset;
    const matched = response.exec(data);
    if (!matched) return false;
    offset = response.lastIndex;
  }
  return true;
}
