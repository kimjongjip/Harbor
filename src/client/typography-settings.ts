export const typographyStorageKey = "harbor.typography.v1";
export const legacyTypographyStorageKey = "harbor.typography";

export type TerminalFont = "d2coding" | "cascadia" | "consolas";
export interface TypographySettings {
  version: 1;
  terminalFont: TerminalFont;
  terminalSize: number;
  terminalLineHeight: number;
  documentSize: number;
  documentLineHeight: number;
  uiSize: number;
}

export const typographyDefaults: Readonly<TypographySettings> = {
  version: 1,
  terminalFont: "d2coding",
  terminalSize: 15,
  terminalLineHeight: 1.45,
  documentSize: 16,
  documentLineHeight: 1.7,
  uiSize: 14,
};

export const typographyBounds = {
  terminalSize: { min: 10, max: 28, step: 1 },
  terminalLineHeight: { min: 1, max: 2, step: 0.05 },
  documentSize: { min: 12, max: 28, step: 1 },
  documentLineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  uiSize: { min: 12, max: 18, step: 1 },
} as const;

function bounded(value: unknown, key: keyof typeof typographyBounds) {
  const { min, max, step } = typographyBounds[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    return typographyDefaults[key];
  return Number(
    (
      Math.round((Math.max(min, Math.min(max, value)) - min) / step) * step +
      min
    ).toFixed(2),
  );
}

/** Only recognized fields enter CSS or xterm. Versionless settings migrate once. */
export function normalizeTypography(value: unknown): TypographySettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...typographyDefaults };
  const item = value as Record<string, unknown>;
  if (item.version !== undefined && item.version !== 1)
    return { ...typographyDefaults };
  const terminalFont = ["d2coding", "cascadia", "consolas"].includes(
    String(item.terminalFont),
  )
    ? (item.terminalFont as TerminalFont)
    : typographyDefaults.terminalFont;
  return {
    version: 1,
    terminalFont,
    terminalSize: bounded(
      item.terminalSize ?? item.terminalFontSize,
      "terminalSize",
    ),
    terminalLineHeight: bounded(
      item.terminalLineHeight ?? item.lineHeight,
      "terminalLineHeight",
    ),
    documentSize: bounded(
      item.documentSize ?? item.documentFontSize,
      "documentSize",
    ),
    documentLineHeight: bounded(item.documentLineHeight, "documentLineHeight"),
    uiSize: bounded(item.uiSize ?? item.uiFontSize, "uiSize"),
  };
}

export function parseTypography(value: string | null): TypographySettings {
  try {
    return normalizeTypography(value ? JSON.parse(value) : undefined);
  } catch {
    return { ...typographyDefaults };
  }
}

export function terminalFontFamily(font: TerminalFont) {
  const fallback = '"Harbor D2Coding", "D2Coding", "Malgun Gothic", monospace';
  if (font === "cascadia") return `"Cascadia Code", ${fallback}`;
  if (font === "consolas") return `Consolas, ${fallback}`;
  return `"Harbor D2Coding", "D2Coding", "Cascadia Code", Consolas, "Malgun Gothic", monospace`;
}

export const uiFontFamily =
  '"Harbor Pretendard", Pretendard, "Segoe UI", "Malgun Gothic", sans-serif';

export function typographyVariables(settings: TypographySettings) {
  return {
    "--font-ui": uiFontFamily,
    "--font-mono": terminalFontFamily(settings.terminalFont),
    "--terminal-font-size": `${settings.terminalSize}px`,
    "--terminal-line-height": String(settings.terminalLineHeight),
    "--document-font-size": `${settings.documentSize}px`,
    "--document-line-height": String(settings.documentLineHeight),
    "--ui-font-size": `${settings.uiSize}px`,
  };
}
