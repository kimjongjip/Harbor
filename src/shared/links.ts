export type LinkTarget =
  | { kind: "web"; url: string; image: boolean }
  | { kind: "file"; path: string; line?: number }
  | { kind: "blocked" };
export function fileParentDirectory(filename: string) {
  const index = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  if (index < 0) return "";
  if (index === 0 || (index === 2 && /^[A-Za-z]:/.test(filename)))
    return filename.slice(0, index + 1);
  return filename.slice(0, index);
}
export function classifyLink(value: string): LinkTarget {
  let href = value.trim();
  if (!href || /[\x00-\x1f]/.test(href)) return { kind: "blocked" };
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      return {
        kind: "web",
        url: url.href,
        image: /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(url.pathname),
      };
    } catch {
      return { kind: "blocked" };
    }
  }
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      href = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(href)) href = href.slice(1);
    } catch {
      return { kind: "blocked" };
    }
  } else if (href.startsWith("sandbox:/")) href = href.slice(8);
  else if (hasBlockedScheme(href)) return { kind: "blocked" };
  else {
    try {
      href = decodeURIComponent(href);
    } catch {}
  }
  // A decoded URI must not introduce a protocol or control character.
  if (/[\x00-\x1f]/.test(href) || hasBlockedScheme(href))
    return { kind: "blocked" };
  if (href.startsWith("#") || href.startsWith("//")) return { kind: "blocked" };
  const line = href.match(/(?::(\d+)(?::\d+)?|#L?(\d+)(?:C\d+)?(?:-L?\d+)?)$/);
  if (line) href = href.slice(0, line.index);
  return {
    kind: "file",
    path: href,
    ...(line ? { line: Number(line[1] || line[2]) } : {}),
  };
}
function hasBlockedScheme(value: string) {
  // A basename with a source line is a file, not a URI scheme (README.md:12).
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !/^[A-Za-z]:[/\\]/.test(value) &&
    !/^[^:/\\]+\.[a-z0-9]+:\d+(?::\d+)?$/i.test(value)
  );
}
export function normalizeMath(text: string) {
  // Keep code blocks and inline code verbatim while accepting both common TeX delimiters.
  return text
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `\n$$\n${body}\n$$\n`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`),
    )
    .join("");
}
export const plainFilePattern =
  /(?:file:\/\/[^\s<>"'`]+|(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/]|~\/)[^\s<>"'`]+|(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+\.[\w]+(?::\d+(?::\d+)?|#L?\d+(?:C\d+)?(?:-L?\d+)?)?|[\p{L}\p{N}_.-]+\.(?:png|jpe?g|webp|gif|bmp|avif|svg|pdf|txt|md|markdown|csv|tsv|json|tsx?|jsx?|py|rs|go|sh|ya?ml|toml)(?::\d+(?::\d+)?|#L?\d+(?:C\d+)?(?:-L?\d+)?)?)/giu;
