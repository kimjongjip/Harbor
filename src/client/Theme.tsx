import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { ITheme } from "@xterm/xterm";
import type { TerminalColors } from "../shared/types";
import {
  darkPalette,
  isThemeName,
  paletteVariables,
  type ThemeName,
} from "./theme-palettes";
export { isDarkTheme, themeOptions, type ThemeName } from "./theme-palettes";

function savedTheme(): ThemeName {
  try {
    const value = localStorage.getItem("harbor.theme");
    return isThemeName(value) ? value : "light";
  } catch {
    return "light";
  }
}
let appliedVariables: string[] = [];
function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  const palette = darkPalette(theme);
  for (const key of appliedVariables) root.style.removeProperty(key);
  const variables = palette ? paletteVariables(palette) : {};
  for (const [key, value] of Object.entries(variables))
    root.style.setProperty(key, value);
  appliedVariables = Object.keys(variables);
  root.dataset.theme = theme;
  root.dataset.appearance = palette ? "dark" : "light";
}
applyTheme(savedTheme());
const ThemeContext = createContext<{
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
}>({ theme: "light", setTheme: () => {} });
export const useTheme = () => useContext(ThemeContext);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  useLayoutEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem("harbor.theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === "harbor.theme" && isThemeName(event.newValue))
        setTheme(event.newValue);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function terminalTheme(theme: ThemeName): ITheme {
  const palette = darkPalette(theme);
  if (palette)
    return {
      background: palette.bg,
      foreground: palette.text,
      cursor: palette.accent,
      cursorAccent: palette.bg,
      selectionBackground: palette.selection,
      selectionInactiveBackground: palette.selectionInactive,
      selectionForeground: "#ffffff",
      black: palette.borderStrong,
      red: palette.red,
      green: palette.green,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.magenta,
      cyan: palette.cyan,
      white: palette.text,
      brightBlack: palette.dim,
      brightRed: palette.red,
      brightGreen: palette.green,
      brightYellow: palette.yellow,
      brightBlue: palette.blue,
      brightMagenta: palette.magenta,
      brightCyan: palette.cyan,
      brightWhite: "#ffffff",
    };
  return {
    background: theme === "paper" ? "#fffdf7" : "#ffffff",
    foreground: "#20242c",
    cursor: "#263859",
    cursorAccent: "#ffffff",
    selectionBackground: theme === "paper" ? "#805020" : "#2457b8",
    selectionInactiveBackground: theme === "paper" ? "#805020" : "#2457b8",
    selectionForeground: "#ffffff",
    black: "#242933",
    red: "#bd2845",
    green: "#267348",
    yellow: "#865c13",
    blue: "#315fba",
    magenta: "#8944a3",
    cyan: "#227a86",
    white: "#545b69",
    brightBlack: "#6b7280",
    brightRed: "#bd2845",
    brightGreen: "#267348",
    brightYellow: "#865c13",
    brightBlue: "#315fba",
    brightMagenta: "#8944a3",
    brightCyan: "#227a86",
    brightWhite: "#161b24",
  };
}
export function terminalColors(theme: ThemeName): TerminalColors {
  const colors = terminalTheme(theme);
  return { foreground: colors.foreground!, background: colors.background! };
}
