export interface DarkPalette {
  label: string;
  bg: string;
  panel: string;
  surface: string;
  chrome: string;
  raised: string;
  text: string;
  muted: string;
  dim: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentSoft: string;
  primary: string;
  primaryHover: string;
  selection: string;
  selectionInactive: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
}

// Shared by the app chrome, xterm and Monaco. Keep color changes in one place.
export const darkPalettes = {
  dark: {
    label: "다크 · 차콜",
    bg: "#1b1d22",
    panel: "#202329",
    surface: "#292d35",
    chrome: "#14161a",
    raised: "#242830",
    text: "#d8dce4",
    muted: "#a4adba",
    dim: "#8a94a3",
    border: "#2d323b",
    borderStrong: "#454e5d",
    accent: "#91b4fb",
    accentSoft: "#26344c",
    primary: "#376ac5",
    primaryHover: "#4072d0",
    selection: "#334d76",
    selectionInactive: "#303a4c",
    red: "#ee919a",
    green: "#9ac6a4",
    yellow: "#e0c18b",
    blue: "#91b4fb",
    magenta: "#c6a4df",
    cyan: "#8bc6cd",
  },
  midnight: {
    label: "다크 · 미드나이트",
    bg: "#161b2a",
    panel: "#1d2436",
    surface: "#283149",
    chrome: "#101421",
    raised: "#252d43",
    text: "#dce1f3",
    muted: "#a8b1cd",
    dim: "#909bb7",
    border: "#303950",
    borderStrong: "#485575",
    accent: "#b9b0ff",
    accentSoft: "#333052",
    primary: "#6553b8",
    primaryHover: "#7563c8",
    selection: "#45406c",
    selectionInactive: "#34394e",
    red: "#f09baa",
    green: "#a5cfb2",
    yellow: "#e8ce9b",
    blue: "#9dbbff",
    magenta: "#c3aff0",
    cyan: "#91cddb",
  },
  mocha: {
    label: "다크 · 모카",
    bg: "#241f1d",
    panel: "#2c2522",
    surface: "#38302a",
    chrome: "#1b1715",
    raised: "#332b26",
    text: "#e8ded3",
    muted: "#beb0a3",
    dim: "#a7998d",
    border: "#40352e",
    borderStrong: "#625145",
    accent: "#e9b989",
    accentSoft: "#493427",
    primary: "#945c36",
    primaryHover: "#a0673d",
    selection: "#654631",
    selectionInactive: "#493b32",
    red: "#ef9c93",
    green: "#b4c59a",
    yellow: "#e6c58a",
    blue: "#a7bfd6",
    magenta: "#d1a9c4",
    cyan: "#9fc8bf",
  },
  forest: {
    label: "다크 · 포레스트",
    bg: "#18211e",
    panel: "#1f2a25",
    surface: "#2a3730",
    chrome: "#111916",
    raised: "#26332c",
    text: "#dce5dc",
    muted: "#a8bcad",
    dim: "#91a696",
    border: "#314238",
    borderStrong: "#4b6153",
    accent: "#9cd1b5",
    accentSoft: "#294636",
    primary: "#31725b",
    primaryHover: "#3c836a",
    selection: "#365c47",
    selectionInactive: "#304238",
    red: "#e7a099",
    green: "#a6cca4",
    yellow: "#ddc68e",
    blue: "#9dbdd4",
    magenta: "#c3aecb",
    cyan: "#9bccc4",
  },
  black: {
    label: "다크 · 블랙",
    bg: "#0b0d10",
    panel: "#14171c",
    surface: "#22272e",
    chrome: "#050608",
    raised: "#1c2128",
    text: "#edf0f7",
    muted: "#b5becb",
    dim: "#99a5b6",
    border: "#343c48",
    borderStrong: "#586577",
    accent: "#bacfff",
    accentSoft: "#1e2e49",
    primary: "#3e6fd2",
    primaryHover: "#4272ce",
    selection: "#304c7c",
    selectionInactive: "#2b3649",
    red: "#ffa6ab",
    green: "#b4e0bc",
    yellow: "#f4d49a",
    blue: "#adcaff",
    magenta: "#dfb9f5",
    cyan: "#a6e1e6",
  },
} satisfies Record<string, DarkPalette>;

export type ThemeName = "light" | "paper" | keyof typeof darkPalettes;
export const themeOptions: { value: ThemeName; label: string }[] = [
  { value: "light", label: "라이트" },
  { value: "paper", label: "페이퍼" },
  ...Object.entries(darkPalettes).map(([value, palette]) => ({
    value: value as ThemeName,
    label: palette.label,
  })),
];
export const isThemeName = (value: string | null): value is ThemeName =>
  themeOptions.some((theme) => theme.value === value);
export function darkPalette(theme: ThemeName): DarkPalette | undefined {
  return theme in darkPalettes
    ? darkPalettes[theme as keyof typeof darkPalettes]
    : undefined;
}
export const isDarkTheme = (theme: ThemeName) => !!darkPalette(theme);

export function paletteVariables(p: DarkPalette): Record<string, string> {
  return {
    "--bg": p.bg,
    "--panel": p.panel,
    "--surface": p.surface,
    "--chrome": p.chrome,
    "--raised": p.raised,
    "--text": p.text,
    "--muted": p.muted,
    "--dim": p.dim,
    "--border": p.border,
    "--border-strong": p.borderStrong,
    "--accent": p.accent,
    "--accent-soft": p.accentSoft,
    "--accent-dark": p.accentSoft,
    "--on-accent": p.chrome,
    "--primary-bg": p.primary,
    "--primary-hover": p.primaryHover,
    "--on-primary": "#ffffff",
    "--success": p.green,
    "--red": p.red,
    "--danger": p.red,
    "--error-soft": `color-mix(in srgb, ${p.red} 12%, ${p.bg})`,
    "--danger-soft": `color-mix(in srgb, ${p.red} 12%, ${p.bg})`,
    "--error-border": `color-mix(in srgb, ${p.red} 35%, ${p.border})`,
    "--warning": p.yellow,
    "--warning-soft": `color-mix(in srgb, ${p.yellow} 10%, ${p.bg})`,
    "--warning-border": `color-mix(in srgb, ${p.yellow} 35%, ${p.border})`,
    "--overlay": "#00000088",
    "--shadow-color": "#00000066",
    "--terminal-bg": p.bg,
    "--selection-bg": p.selection,
    "--selection-text": "#ffffff",
    "--color-scheme": "dark",
  };
}
