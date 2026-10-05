import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ITheme } from "@xterm/xterm";
import type { TerminalColors } from "../shared/types";

export type ThemeName = "light" | "dark" | "paper";
const valid = (value: string | null): value is ThemeName =>
  value === "light" || value === "dark" || value === "paper";
function savedTheme(): ThemeName {
  try {
    const value = localStorage.getItem("harbor.theme");
    return valid(value) ? value : "light";
  } catch {
    return "light";
  }
}
document.documentElement.dataset.theme = savedTheme();
const ThemeContext = createContext<{
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
}>({ theme: "light", setTheme: () => {} });
export const useTheme = () => useContext(ThemeContext);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("harbor.theme", theme);
  }, [theme]);
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === "harbor.theme" && valid(event.newValue))
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
  const dark = theme === "dark";
  return {
    background: dark ? "#181b21" : theme === "paper" ? "#fffdf7" : "#ffffff",
    foreground: dark ? "#e6e8ee" : "#20242c",
    cursor: dark ? "#a4b9ff" : "#263859",
    cursorAccent: dark ? "#181b21" : "#ffffff",
    selectionBackground: dark ? "#a4b9ff" : theme === "paper" ? "#805020" : "#2457b8",
    selectionInactiveBackground: dark ? "#a4b9ff" : theme === "paper" ? "#805020" : "#2457b8",
    selectionForeground: dark ? "#111827" : "#ffffff",
    black: dark ? "#30343d" : "#242933",
    red: dark ? "#f88a91" : "#bd2845",
    green: dark ? "#93d1a3" : "#267348",
    yellow: dark ? "#eac283" : "#865c13",
    blue: dark ? "#8eafff" : "#315fba",
    magenta: dark ? "#cfa2ed" : "#8944a3",
    cyan: dark ? "#8fd0d7" : "#227a86",
    white: dark ? "#e6e8ee" : "#545b69",
    brightBlack: dark ? "#9299a8" : "#6b7280",
    brightRed: dark ? "#ffa4aa" : "#bd2845",
    brightGreen: dark ? "#a2e1b2" : "#267348",
    brightYellow: dark ? "#f6d297" : "#865c13",
    brightBlue: dark ? "#a4b9ff" : "#315fba",
    brightMagenta: dark ? "#dab7f1" : "#8944a3",
    brightCyan: dark ? "#a9e1e6" : "#227a86",
    brightWhite: dark ? "#ffffff" : "#161b24",
  };
}
export function terminalColors(theme: ThemeName): TerminalColors {
  const colors = terminalTheme(theme);
  return { foreground: colors.foreground!, background: colors.background! };
}
