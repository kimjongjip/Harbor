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
