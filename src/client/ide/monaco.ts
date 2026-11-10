import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/basic-languages/monaco.contribution.js";
// Monaco 0.57 exports JavaScript subpaths only; load its bundled font CSS directly.
import "../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { darkPalettes, isDarkTheme, type ThemeName } from "../theme-palettes";

for (const [name, p] of Object.entries(darkPalettes)) {
  monaco.editor.defineTheme(`harbor-${name}`, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: p.dim.slice(1) },
      { token: "keyword", foreground: p.magenta.slice(1) },
      { token: "string", foreground: p.green.slice(1) },
      { token: "number", foreground: p.yellow.slice(1) },
      { token: "type", foreground: p.cyan.slice(1) },
      { token: "delimiter", foreground: p.muted.slice(1) },
    ],
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.text,
      "editorGutter.background": p.bg,
      "editorLineNumber.foreground": p.dim,
      "editorLineNumber.activeForeground": p.text,
      "editor.selectionBackground": p.selection,
      "editor.inactiveSelectionBackground": p.selectionInactive,
      "editor.lineHighlightBackground": p.panel,
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": p.accent,
      "editorWhitespace.foreground": p.borderStrong,
      "editorIndentGuide.background1": p.border,
      "editorIndentGuide.activeBackground1": p.borderStrong,
      "editorWidget.background": p.raised,
      "editorWidget.border": p.borderStrong,
      "editorSuggestWidget.background": p.raised,
      "editorSuggestWidget.foreground": p.text,
      "editorSuggestWidget.selectedBackground": p.accentSoft,
      "editorSuggestWidget.highlightForeground": p.accent,
      "input.background": p.chrome,
      "input.foreground": p.text,
      "input.border": p.borderStrong,
      "editor.findMatchBackground": p.yellow + "50",
      "editor.findMatchHighlightBackground": p.yellow + "25",
      "scrollbarSlider.background": p.borderStrong + "99",
      "scrollbarSlider.hoverBackground": p.dim + "88",
      "list.hoverBackground": p.surface,
      focusBorder: p.accent,
    },
  });
}
export const editorThemeName = (theme: ThemeName) =>
  isDarkTheme(theme) ? `harbor-${theme}` : "vs";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
export { monaco };
export function languageFor(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1) || "";
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        json: "json",
        md: "markdown",
        py: "python",
        rs: "rust",
        go: "go",
        c: "c",
        h: "cpp",
        cpp: "cpp",
        cc: "cpp",
        hpp: "cpp",
        cs: "csharp",
        java: "java",
        html: "html",
        htm: "html",
        css: "css",
        scss: "scss",
        sh: "shell",
        bash: "shell",
        ps1: "powershell",
        sql: "sql",
        yaml: "yaml",
        yml: "yaml",
        xml: "xml",
        svg: "xml",
        toml: "ini",
      } as Record<string, string>
    )[extension] || "plaintext"
  );
}
