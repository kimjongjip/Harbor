import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileCode2,
  Folder,
  FolderOpen,
  GitCompareArrows,
  LoaderCircle,
  Quote,
  RefreshCw,
  Save,
  Search,
  X,
  ExternalLink,
} from "lucide-react";
import { monaco, languageFor } from "./monaco";
import {
  dirtyFile,
  documentKey,
  fileName,
  savedFile,
  selectionText,
} from "./state";
import {
  IdeApiError,
  type IdeApi,
  type IdeFile,
  type IdeEncoding,
  type IdeFileDetails,
  type IdeSelection,
  type IdeTree,
  type IdeMediaView,
} from "./types";
import "./ide.css";
import ResizableSidebar from "../ResizableSidebar";
import {
  MarkdownReading,
  isMarkdownFile,
  type MarkdownRenderer,
} from "./MarkdownReading";

interface TextDocument {
  kind: "text";
  key: string;
  file: IdeFile;
  hostLabel?: string;
  model: monaco.editor.ITextModel;
  conflict?: IdeFile;
  saving?: boolean;
  markdownView?: "preview" | "source" | "split";
  disposeChange: () => void;
}
interface MediaDocument {
  kind: "media";
  key: string;
  file: IdeFile;
  hostLabel?: string;
  media: "image" | "pdf";
  revision: number;
  views: [IdeMediaView, IdeMediaView];
}
type OpenDocument = TextDocument | MediaDocument;
const isDirty = (doc: OpenDocument) =>
  doc.kind === "text" && dirtyFile(doc.file, doc.model.getValue());
export interface IdeWorkspaceProps {
  api: IdeApi;
  terminalId: string;
  hostId: string;
  hostLabel?: string;
  workspaceCwd?: string;
  theme?: "light" | "dark" | "paper";
  visible?: boolean;
  onQuote?: (selection: IdeSelection) => Promise<void>;
  onPreview?: (file: IdeFile) => void;
  renderMedia?: (
    file: IdeFile,
    kind: "image" | "pdf",
    view: IdeMediaView,
  ) => ReactNode;
  renderMarkdown?: MarkdownRenderer;
}

function FileTree({
  tree,
  api,
  onOpen,
  onError,
}: {
  tree: IdeTree;
  api: IdeApi;
  onOpen: (path: string) => void;
  onError: (message: string) => void;
}) {
  const [directories, setDirectories] = useState<Record<string, IdeTree>>({});
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(new Set<string>());
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setDirectories({});
    setExpanded(new Set());
    setLoading(new Set());
  }, [tree]);
  async function toggle(path: string) {
    if (loading.has(path)) return;
    if (expanded.has(path)) {
      setExpanded((old) => {
        const next = new Set(old);
        next.delete(path);
        return next;
      });
      return;
    }
    if (directories[path]) {
      setExpanded((old) => new Set(old).add(path));
      return;
    }
    const captured = generation.current;
    setLoading((old) => new Set(old).add(path));
    try {
      const result = await api.tree(tree.terminalId, path);
      if (generation.current !== captured) return;
      if (result.binding !== tree.binding)
        throw new Error(
          "터미널의 작업 폴더가 바뀌었습니다. 파일 목록을 새로고침해주세요.",
        );
      setDirectories((old) => ({ ...old, [path]: result }));
      setExpanded((old) => new Set(old).add(path));
    } catch (error) {
      if (generation.current === captured) onError((error as Error).message);
    } finally {
      if (generation.current === captured)
        setLoading((old) => {
          const next = new Set(old);
          next.delete(path);
          return next;
        });
    }
  }
  function render(view: IdeTree, depth: number) {
    const entries = [...view.entries].sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
    return entries.map((entry) => {
      const folder = entry.kind === "directory";
      const open = expanded.has(entry.path);
      return (
        <div
          key={entry.path}
          role="treeitem"
          aria-expanded={folder ? open : undefined}
        >
          <button
            className="ide-file-row"
            style={{ paddingLeft: 10 + depth * 14 }}
            title={entry.path}
            onClick={() =>
              folder ? void toggle(entry.path) : onOpen(entry.path)
            }
          >
            {loading.has(entry.path) ? (
              <LoaderCircle size={13} className="ide-spinner" />
            ) : folder ? (
              open ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : (
              <span className="ide-tree-spacer" />
            )}
            {folder ? (
              open ? (
                <FolderOpen size={14} />
              ) : (
                <Folder size={14} />
              )
            ) : (
              <FileCode2 size={14} />
            )}
            <span>{entry.name}</span>
          </button>
          {folder && open && directories[entry.path] && (
            <div role="group">{render(directories[entry.path], depth + 1)}</div>
          )}
        </div>
      );
    });
  }
  return (
    <div role="tree" aria-label="작업 폴더 파일">
      {render(tree, 0)}
      {tree.truncated && (
        <p className="ide-muted">
          일부 파일만 표시됩니다. 경로 입력으로 파일을 열 수 있습니다.
        </p>
      )}
    </div>
  );
}

function EditorPane({
  document,
  comparison,
  theme,
  onFocus,
  onReady,
}: {
  document?: TextDocument;
  comparison?: string;
  theme: string;
  onFocus: () => void;
  onReady: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onFocus, onReady });
  callbacks.current = { onFocus, onReady };
  useEffect(() => {
    if (!element.current || !document) return;
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      model: document.model,
      theme,
      automaticLayout: true,
      fontSize: 14,
      lineHeight: 22,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      padding: { top: 8 },
      tabSize: 2,
      renderWhitespace: "selection",
      accessibilitySupport: "auto",
      editContext: false,
    };
    let editor: monaco.editor.IStandaloneCodeEditor;
    let diff: monaco.editor.IStandaloneDiffEditor | undefined;
    let original: monaco.editor.ITextModel | undefined;
    if (comparison !== undefined) {
      original = monaco.editor.createModel(
        comparison,
        document.model.getLanguageId(),
      );
      const { model: _model, ...diffOptions } = options;
      diff = monaco.editor.createDiffEditor(element.current, {
        ...diffOptions,
        originalEditable: false,
        renderSideBySide: true,
        enableSplitViewResizing: true,
      });
      diff.setModel({ original, modified: document.model });
      editor = diff.getModifiedEditor();
    } else editor = monaco.editor.create(element.current, options);
    const focus = editor.onDidFocusEditorWidget(() =>
      callbacks.current.onFocus(),
    );
    callbacks.current.onReady(editor);
    return () => {
      callbacks.current.onReady(null);
      focus.dispose();
      diff ? diff.dispose() : editor.dispose();
      original?.dispose();
    };
  }, [document?.key, comparison]);
  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);
  return (
    <div
      className="ide-editor-pane"
      ref={element}
      data-testid="ide-editor-pane"
    >
      {!document && (
        <div className="ide-empty">
          <FileCode2 size={30} />
          <strong>파일을 선택하세요</strong>
          <span>
            같은 서버의 파일을 편집하고, 열린 세션에서 작업을 이어갑니다.
          </span>
        </div>
      )}
    </div>
  );
}

export default function IdeWorkspace({
  api,
  terminalId,
  hostId,
  hostLabel,
  workspaceCwd,
  theme = "light",
  visible = true,
  onQuote,
  onPreview,
  renderMedia,
  renderMarkdown,
}: IdeWorkspaceProps) {
  const [tree, setTree] = useState<IdeTree | null>(null);
  const [path, setPath] = useState("");
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [panes, setPanes] = useState<[string, string]>(["", ""]);
  const [focused, setFocused] = useState<0 | 1>(0);
  const [split, setSplit] = useState(false);
  const [diffKey, setDiffKey] = useState("");
  const [error, setError] = useState("");
  const [fileIssue, setFileIssue] = useState<IdeFileDetails | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [, repaint] = useState(0);
  const editors = useRef<(monaco.editor.IStandaloneCodeEditor | null)[]>([
    null,
    null,
  ]);
  const namespace = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const opening = useRef(new Set<string>());
  const active = documents.find((doc) => doc.key === panes[focused]);
  const monacoTheme = theme === "dark" ? "vs-dark" : "vs";

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (documentsRef.current.some(isDirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      for (const doc of documentsRef.current) {
        if (doc.kind !== "text") continue;
        doc.disposeChange();
        doc.model.dispose();
      }
    };
  }, []);

  async function loadTree() {
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    setFileIssue(null);
    try {
      const result = await api.tree(terminalId);
      if (ticket !== generation.current) return;
      setTree(result);
      setPath("");
    } catch (error) {
      if (ticket === generation.current) setError((error as Error).message);
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setTree(null);
    if (terminalId) void loadTree();
    return () => {
      generation.current++;
    };
  }, [api, terminalId, hostId]);

  function updateDocument(key: string, update: Partial<TextDocument>) {
    setDocuments((current) =>
      current.map((doc) =>
        doc.key === key && doc.kind === "text" ? { ...doc, ...update } : doc,
      ),
    );
  }
  async function open(path: string, encoding?: IdeEncoding, source?: IdeFile) {
    const sourceTerminal = source?.terminalId || terminalId;
    const sourceHost = source?.hostId || hostId;
    const requestKey = `${sourceTerminal}\0${path}`;
    if (opening.current.has(requestKey)) return;
    opening.current.add(requestKey);
    const ticket = generation.current;
    setError("");
    setFileIssue(null);
    setStatus("파일 불러오는 중…");
    try {
      const retainedEncoding = documentsRef.current.find(
        (doc) => doc.file.hostId === sourceHost && doc.file.path === path,
      )?.file.encoding;
      const file = await api.read(
        sourceTerminal,
        path,
        encoding || retainedEncoding,
      );
      if (generation.current !== ticket) return;
      const key = documentKey(file);
      const previous = documentsRef.current.find((doc) => doc.key === key);
      if (previous?.kind === "text") {
        if (
          previous.file.binding !== file.binding ||
          previous.file.version !== file.version
        ) {
          if (dirtyFile(previous.file, previous.model.getValue())) {
            updateDocument(key, { conflict: file });
            setDiffKey(key);
          } else {
            previous.model.setValue(file.content);
            updateDocument(key, { file, conflict: undefined });
          }
        }
      } else {
        const uri = monaco.Uri.from({
          scheme: "harbor-editor",
          authority: namespace.current,
          path: `/${encodeURIComponent(file.hostId)}/${encodeURIComponent(file.path)}`,
        });
        const model = monaco.editor.createModel(
          file.content,
          languageFor(file.path),
          uri,
        );
        const listener = model.onDidChangeContent(() =>
          repaint((value) => value + 1),
        );
        const document: TextDocument = {
          kind: "text",
          key,
          file,
          hostLabel:
            sourceHost === hostId
              ? hostLabel
              : documentsRef.current.find(
                  (doc) => doc.file.hostId === sourceHost,
                )?.hostLabel,
          model,
          disposeChange: () => listener.dispose(),
        };
        documentsRef.current = [
          ...documentsRef.current.filter((doc) => doc.key !== key),
          document,
        ];
        setDocuments(documentsRef.current);
      }
      setPanes((old) => (focused === 0 ? [key, old[1]] : [old[0], key]));
      setStatus("");
    } catch (error) {
      if (generation.current !== ticket) return;
      setStatus("");
      if (error instanceof IdeApiError && error.details) {
        const details = error.details;
        if (
          ["EDITOR_BINARY", "EDITOR_TOO_LARGE"].includes(error.code || "") &&
          (details.preview === "image" || details.preview === "pdf") &&
          renderMedia
        ) {
          const file = {
            ...details,
            content: "",
            version: "",
            binding: tree?.binding || "",
          };
          const key = documentKey(file);
          const previous = documentsRef.current.find((doc) => doc.key === key);
          if (!previous) {
            const document: MediaDocument = {
              kind: "media",
              key,
              file,
              hostLabel,
              media: details.preview,
              revision: 0,
              views: [{}, {}],
            };
            documentsRef.current = [...documentsRef.current, document];
            setDocuments(documentsRef.current);
          }
          setPanes((old) => (focused === 0 ? [key, old[1]] : [old[0], key]));
          return;
        }
        if (
          ["EDITOR_BINARY", "EDITOR_TOO_LARGE"].includes(error.code || "") &&
          error.details.preview !== "download" &&
          onPreview
        ) {
          onPreview({
            ...error.details,
            content: "",
            version: "",
            binding: tree?.binding || "",
          });
          return;
        }
        setFileIssue(error.details);
      }
      setError((error as Error).message);
    } finally {
      opening.current.delete(requestKey);
    }
  }

  async function save(doc: TextDocument, against?: IdeFile) {
    if (doc.saving) return;
    const draft = doc.model.getValue();
    updateDocument(doc.key, { saving: true });
    setError("");
    setFileIssue(null);
    setStatus("");
    try {
      const file = savedFile(
        against || doc.file,
        await api.save(against || doc.file, draft),
      );
      updateDocument(doc.key, { file, conflict: undefined, saving: false });
      setDiffKey((key) => (key === doc.key ? "" : key));
      // The model can change while saving. Only the acknowledged snapshot becomes the base.
      setStatus(
        `${fileName(file.path)} 저장됨${doc.model.getValue() !== draft ? " · 새 편집 내용은 아직 저장되지 않았습니다" : ""}`,
      );
    } catch (error) {
      updateDocument(doc.key, { saving: false });
      if (error instanceof IdeApiError && error.current) {
        updateDocument(doc.key, { conflict: error.current });
        setDiffKey(doc.key);
      }
      setError((error as Error).message);
    }
  }

  async function refreshFile(doc: OpenDocument) {
    if (doc.kind === "media") {
      setDocuments((current) =>
        current.map((item) =>
          item.key === doc.key && item.kind === "media"
            ? { ...item, revision: item.revision + 1 }
            : item,
        ),
      );
      return;
    }
    if (doc.saving) return;
    setError("");
    setFileIssue(null);
    try {
      const current = await api.read(
        doc.file.terminalId,
        doc.file.path,
        doc.file.encoding,
      );
      if (dirtyFile(doc.file, doc.model.getValue())) {
        updateDocument(doc.key, { conflict: current });
        setDiffKey(doc.key);
      } else {
        doc.model.setValue(current.content);
        updateDocument(doc.key, { file: current, conflict: undefined });
      }
    } catch (error) {
      setError((error as Error).message);
    }
  }
  function close(doc: OpenDocument) {
    if (
      (doc.kind === "text" && doc.saving) ||
      (isDirty(doc) &&
        !window.confirm(
          `${fileName(doc.file.path)}의 저장하지 않은 변경을 버리고 닫을까요?`,
        ))
    )
      return;
    const remaining = documentsRef.current.filter(
      (item) => item.key !== doc.key,
    );
    documentsRef.current = remaining;
    setDocuments(remaining);
    setPanes(
      (old) =>
        old.map((key) =>
          key === doc.key ? remaining.at(-1)?.key || "" : key,
        ) as [string, string],
    );
    if (doc.kind === "text") {
      doc.disposeChange();
      doc.model.dispose();
    }
  }
  async function quote() {
    const editor = editors.current[focused];
    const selection = editor?.getSelection();
    if (active?.kind !== "text" || !editor || !selection || !onQuote) return;
    const value: IdeSelection = {
      terminalId: active.file.terminalId,
      hostId: active.file.hostId,
      path: active.file.path,
      root: active.file.root,
      text: active.model.getValueInRange(selection),
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      startColumn: selection.startColumn,
      endColumn: selection.endColumn,
      unsaved: dirtyFile(active.file, active.model.getValue()),
    };
    setQuoteBusy(true);
    setError("");
    setFileIssue(null);
    try {
      selectionText(value);
      await onQuote(value);
      setStatus("AI 대화에 인용을 준비했습니다. 질문을 적고 보내세요.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setQuoteBusy(false);
    }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        !visible ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      )
        return;
      const target = event.target as Element | null;
      if (!target?.closest(".harbor-ide")) return;
      event.preventDefault();
      event.stopPropagation();
      if (active?.kind === "text" && !active.conflict) void save(active);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [active, visible]);

  return (
    <section
      className="harbor-ide"
      aria-label="IDE 작업 공간"
      hidden={!visible}
      data-testid="harbor-ide"
    >
      <ResizableSidebar className="ide-explorer" variant="ide">
        <div className="ide-explorer-title">
          <strong title={tree?.root}>{hostLabel || "파일"}</strong>
          <button
            title="작업 폴더 새로고침"
            aria-label="작업 폴더 새로고침"
            onClick={() => void loadTree()}
            disabled={busy}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="ide-root" title={tree?.root}>
          {tree?.root || "작업 폴더 연결 중…"}
        </div>
        <form
          className="ide-path"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) void open(path.trim());
          }}
        >
          <input
            aria-label="열 파일 경로"
            placeholder="파일 경로로 열기"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" aria-label="파일 열기">
            <ArrowRight size={14} />
          </button>
        </form>
        <div className="ide-tree-scroll">
          {busy ? (
            <p className="ide-muted">파일 목록 불러오는 중…</p>
          ) : tree ? (
            <FileTree
              tree={tree}
              api={api}
              onOpen={(path) => void open(path)}
              onError={setError}
            />
          ) : (
            <p className="ide-muted">열려 있는 터미널을 선택하세요.</p>
          )}
        </div>
      </ResizableSidebar>
      <div className="ide-main">
        <div className="ide-tabs" role="tablist" aria-label="열린 파일">
          {documents.map((doc) => (
            <div
              className={`ide-tab ${active?.key === doc.key ? "active" : ""}`}
              key={doc.key}
            >
              <button
                role="tab"
                aria-selected={active?.key === doc.key}
                title={`${doc.hostLabel || doc.file.hostId} · ${doc.file.path}`}
                onClick={() =>
                  setPanes((old) =>
                    focused === 0 ? [doc.key, old[1]] : [old[0], doc.key],
                  )
                }
              >
                <FileCode2 size={13} />
                {doc.file.hostId !== hostId && (
                  <small>{doc.hostLabel || doc.file.hostId} · </small>
                )}
                {fileName(doc.file.path)}
                {isDirty(doc) && <span aria-label="저장 안 됨">●</span>}
              </button>
              <button
                title="파일 닫기"
                aria-label={`${fileName(doc.file.path)} 닫기`}
                onClick={() => close(doc)}
                disabled={doc.kind === "text" && doc.saving}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="ide-toolbar">
          <span title={active?.file.path}>
            {active?.file.path || "파일을 열어 편집하세요"}
          </span>
          <button
            title="저장 (Ctrl+S)"
            aria-label="파일 저장"
            disabled={
              active?.kind !== "text" || active.saving || !!active.conflict
            }
            onClick={() => active?.kind === "text" && void save(active)}
          >
            <Save size={15} />
          </button>
          <button
            title="파일 새로고침 · 변경 비교"
            aria-label="파일 새로고침"
            disabled={!active || (active.kind === "text" && active.saving)}
            onClick={() => active && void refreshFile(active)}
          >
            <RefreshCw size={15} />
          </button>
          <button
            title="찾기 / 바꾸기 (Ctrl+F / Ctrl+H)"
            aria-label="찾기 및 바꾸기"
            disabled={active?.kind !== "text"}
            onClick={() => {
              if (active && isMarkdownFile(active.file.path))
                updateDocument(active.key, { markdownView: "source" });
              requestAnimationFrame(() => {
                editors.current[focused]?.focus();
                editors.current[focused]?.trigger(
                  "harbor",
                  "editor.action.startFindReplaceAction",
                  null,
                );
              });
            }}
          >
            <Search size={15} />
          </button>
          <button
            title="저장된 버전과 비교"
            aria-label="변경 비교"
            aria-pressed={!!active && diffKey === active.key}
            disabled={active?.kind !== "text"}
            onClick={() =>
              active && setDiffKey(diffKey === active.key ? "" : active.key)
            }
          >
            <GitCompareArrows size={15} />
          </button>
          <button
            title="편집기 나누기"
            aria-label="편집기 나누기"
            aria-pressed={split}
            onClick={() => {
              if (!split) setPanes((old) => [old[0], old[1] || old[0]]);
              else setFocused(0);
              setSplit(!split);
            }}
          >
            <Columns2 size={15} />
          </button>
          {onPreview && (
            <button
              title="파일을 별도 창에서 열기"
              aria-label="파일을 별도 창에서 열기"
              disabled={!active}
              onClick={() => active && onPreview(active.file)}
            >
              <ExternalLink size={15} />
            </button>
          )}
          {onQuote && (
            <button
              className="ide-quote"
              title="선택한 코드로 AI에 질문"
              disabled={
                active?.kind !== "text" ||
                quoteBusy ||
                (isMarkdownFile(active.file.path) &&
                  (active.markdownView || "preview") === "preview")
              }
              onClick={() => void quote()}
            >
              <Quote size={14} />
              인용
            </button>
          )}
        </div>
        {active?.kind === "text" && isMarkdownFile(active.file.path) && (
          <div
            className="ide-markdown-modes"
            role="group"
            aria-label="Markdown 보기 방식"
          >
            <span>Markdown</span>
            {(
              [
                ["preview", "읽기"],
                ["source", "원문"],
                ["split", "나란히 보기"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                aria-pressed={(active.markdownView || "preview") === mode}
                onClick={() => {
                  setDiffKey("");
                  updateDocument(active.key, { markdownView: mode });
                }}
              >
                {label}
              </button>
            ))}
            {dirtyFile(active.file, active.model.getValue()) && (
              <small>저장하지 않은 편집 내용 미리보기</small>
            )}
          </div>
        )}
        {active?.kind === "text" && active.conflict && (
          <div className="ide-conflict" role="alert">
            <span>
              서버 파일이 변경되었습니다. 왼쪽은 서버, 오른쪽은 내 편집
              내용입니다.
            </span>
            <button
              disabled={active.saving}
              onClick={() => {
                const current = active.conflict!;
                if (
                  window.confirm("내 편집 내용을 버리고 서버 파일로 바꿀까요?")
                ) {
                  active.model.setValue(current.content);
                  updateDocument(active.key, {
                    file: current,
                    conflict: undefined,
                  });
                  setDiffKey("");
                }
              }}
            >
              서버 버전 사용
            </button>
            <button
              disabled={active.saving}
              onClick={() => {
                if (
                  window.confirm(
                    "비교한 서버 버전을 현재 편집 내용으로 덮어쓸까요? 이후 서버 변경이 있으면 다시 확인합니다.",
                  )
                )
                  void save(active, active.conflict);
              }}
            >
              내 편집 내용 저장
            </button>
          </div>
        )}
        {error && (
          <div className="ide-error" role="alert">
            <span>{error}</span>
            {fileIssue?.encodings?.includes("cp949") && (
              <button onClick={() => void open(fileIssue.path, "cp949")}>
                한글 Windows (CP949)로 열기
              </button>
            )}
            {fileIssue && onPreview && !fileIssue.encodings?.length && (
              <button
                onClick={() =>
                  onPreview({
                    ...fileIssue,
                    content: "",
                    version: "",
                    binding: tree?.binding || "",
                  })
                }
              >
                {fileIssue.preview === "download"
                  ? "파일 보기 / 다운로드"
                  : "미리보기 열기"}
              </button>
            )}
            <button
              aria-label="IDE 오류 닫기"
              onClick={() => {
                setError("");
                setFileIssue(null);
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className={`ide-editors ${split ? "split" : ""}`}>
          {([0, 1] as const)
            .filter((index) => !index || split)
            .map((index) => {
              const doc = documents.find((item) => item.key === panes[index]);
              return (
                <div
                  className={`ide-pane-shell ${focused === index ? "focused" : ""}`}
                  key={index}
                  onPointerDown={() => setFocused(index)}
                >
                  {doc?.kind === "media" ? (
                    <div
                      className="ide-media-host"
                      key={`${doc.key}:${doc.revision}`}
                    >
                      {renderMedia?.(doc.file, doc.media, doc.views[index])}
                    </div>
                  ) : (
                    <div
                      className={`ide-document-pane ${doc && isMarkdownFile(doc.file.path) && !doc.conflict && diffKey !== doc.key ? `markdown-${doc.markdownView || "preview"}` : "source-only"}`}
                    >
                      <div
                        className="ide-source-host"
                        hidden={
                          !!doc &&
                          isMarkdownFile(doc.file.path) &&
                          !doc.conflict &&
                          diffKey !== doc.key &&
                          (doc.markdownView || "preview") === "preview"
                        }
                      >
                        <EditorPane
                          document={doc}
                          comparison={
                            doc && (doc.conflict || diffKey === doc.key)
                              ? (doc.conflict?.content ?? doc.file.content)
                              : undefined
                          }
                          theme={monacoTheme}
                          onFocus={() => setFocused(index)}
                          onReady={(editor) => {
                            editors.current[index] = editor;
                          }}
                        />
                      </div>
                      {doc &&
                        isMarkdownFile(doc.file.path) &&
                        !doc.conflict &&
                        diffKey !== doc.key &&
                        doc.markdownView !== "source" && (
                          <MarkdownReading
                            key={doc.key}
                            text={doc.model.getValue()}
                            file={doc.file}
                            onOpenFile={(path) =>
                              void open(path, undefined, doc.file)
                            }
                            renderMarkdown={renderMarkdown}
                          />
                        )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
        <div className="ide-status" role="status">
          {status ||
            (active?.kind === "media"
              ? `${active.media === "pdf" ? "PDF" : "이미지"} · 읽기 전용`
              : active
                ? `${active.model.getLanguageId()} · ${(active.file.encoding || "utf-8").toUpperCase()}${active.file.bom ? " BOM" : ""}${dirtyFile(active.file, active.model.getValue()) ? " · 저장하지 않은 변경" : ""}`
                : "파일은 선택한 터미널의 서버에서 열립니다.")}
        </div>
      </div>
    </section>
  );
}
