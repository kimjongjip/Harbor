import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  legacyTypographyStorageKey,
  normalizeTypography,
  parseTypography,
  terminalFontFamily,
  typographyDefaults,
  typographyStorageKey,
  typographyVariables,
  type TypographySettings,
} from "./typography-settings";

function savedSettings() {
  try {
    return parseTypography(
      localStorage.getItem(typographyStorageKey) ??
        localStorage.getItem(legacyTypographyStorageKey),
    );
  } catch {
    return { ...typographyDefaults };
  }
}

function applySettings(settings: TypographySettings) {
  for (const [name, value] of Object.entries(typographyVariables(settings)))
    document.documentElement.style.setProperty(name, value);
}

if (typeof document !== "undefined") applySettings(savedSettings());

const TypographyContext = createContext({
  settings: { ...typographyDefaults } as TypographySettings,
  updateSettings: (_: Partial<Omit<TypographySettings, "version">>) => {},
  resetSettings: () => {},
  fontsReady: false,
});

export const useTypography = () => useContext(TypographyContext);

export function TypographyProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<TypographySettings>(savedSettings);
  const [fontsReady, setFontsReady] = useState(false);
  const updateSettings = useCallback(
    (patch: Partial<Omit<TypographySettings, "version">>) => {
      setSettings((previous) => normalizeTypography({ ...previous, ...patch }));
    },
    [],
  );
  const resetSettings = useCallback(
    () => setSettings({ ...typographyDefaults }),
    [],
  );

  useLayoutEffect(() => {
    applySettings(settings);
    try {
      localStorage.setItem(typographyStorageKey, JSON.stringify(settings));
      localStorage.removeItem(legacyTypographyStorageKey);
    } catch {}
  }, [settings]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === typographyStorageKey || event.key === null)
        setSettings(
          parseTypography(event.key === null ? null : event.newValue),
        );
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    let current = true;
    setFontsReady(false);
    if (!document.fonts) {
      setFontsReady(true);
      return;
    }
    // Both weights must settle before xterm measures its cells. Loading failure
    // still enables the explicit Korean/Latin fallback stack.
    Promise.allSettled([
      document.fonts.load(
        `400 ${settings.terminalSize}px ${terminalFontFamily(settings.terminalFont)}`,
        "한글ABC012─│",
      ),
      document.fonts.load(
        `700 ${settings.terminalSize}px ${terminalFontFamily(settings.terminalFont)}`,
        "한글ABC012─│",
      ),
      document.fonts.load('400 16px "Harbor Pretendard"', "한글 읽기 ABC"),
    ]).then(() => {
      if (current) setFontsReady(true);
    });
    return () => {
      current = false;
    };
  }, [settings.terminalFont, settings.terminalSize]);

  return (
    <TypographyContext.Provider
      value={{ settings, updateSettings, resetSettings, fontsReady }}
    >
      {children}
    </TypographyContext.Provider>
  );
}
