import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  ArrowDownToLine,
  Copy,
  ExternalLink,
  File,
  FolderOpen,
  Image,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  Grip,
} from "lucide-react";
import { Modal } from "./Dialogs";
import { api, getToken } from "./api";
import { classifyLink, fileParentDirectory } from "../shared/links";
import type { HostView } from "../shared/types";
import { Markdown } from "./RichMarkdown";
import { DelimitedPreview } from "./DelimitedPreview";
import { usePreviewSize } from "./preview-size";
import { useDocumentZoom } from "./useDocumentZoom";
import { resolvePreviewBase } from "./previewPath";
import { copyPreviewImage } from "./preview-clipboard";
import { svgImageUrl } from "./svg-image";
import "./resource-preview.css";

export interface ResourceLocation {
  hostId: string;
  cwd: string;
}
export interface Target {
  hostId?: string;
  cwd?: string;
  path?: string;
  url?: string;
  image?: boolean;
  line?: number;
}
const PreviewContext = createContext<
  (href: string, location?: ResourceLocation, forceImage?: boolean) => void
>(() => {});
export const ResourceContext = createContext<ResourceLocation | undefined>(
  undefined,
);
export const usePreview = () => useContext(PreviewContext);
export function fileUrl(
  hostId: string,
  path: string,
  type: "image" | "download" | "pdf" = "download",
) {
  return `/api/hosts/${hostId}/files/${type}?${new URLSearchParams({ path, token: getToken() })}`;
}
export function PreviewProvider({
  children,
  hosts,
  onFolder,
  initialTarget,
  standalone = false,
}: {
  children: ReactNode;
  hosts: HostView[];
  onFolder: (hostId: string, path: string) => void;
  initialTarget?: Target;
  standalone?: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(initialTarget || null);
  const open = useCallback(
    (href: string, location?: ResourceLocation, forceImage?: boolean) => {
      const openFile = (next: Target) => {
        const url = new URL(window.location.origin + "/");
        url.searchParams.set("preview", "1");
        url.hash = new URLSearchParams({
          target: JSON.stringify(next),
        }).toString();
        const child = window.open(
          url.href,
          "_blank",
          "popup,width=1100,height=850,resizable=yes,scrollbars=yes",
        );
        // Electron handles same-origin popups natively and returns null.
        // Retain access to the file if a regular browser blocks the popup.
        if (!child && !window.harborDesktop) setTarget(next);
      };
      const link = classifyLink(href);
      if (link.kind === "web") {
        if (link.image || forceImage) openFile({ url: link.url, image: true });
        else window.open(link.url, "_blank", "noopener,noreferrer");
      } else if (link.kind === "file" && location)
        openFile({
          hostId: location.hostId,
          cwd: location.cwd,
          path: link.path,
          line: link.line,
        });
    },
    [],
  );
  const close = useCallback(() => {
    if (standalone) window.close();
    else setTarget(null);
  }, [standalone]);
  return (
    <PreviewContext.Provider value={open}>
      {children}
      {target && (
        <ResourcePreview
          key={JSON.stringify(target)}
          target={target}
          hosts={hosts}
          onClose={close}
          onFolder={onFolder}
          standalone={standalone}
        />
      )}
    </PreviewContext.Provider>
  );
}
interface PreviewData {
  kind: "image" | "text" | "binary" | "directory" | "pdf";
  name: string;
  path: string;
  size: number;
  text?: string;
  truncated?: boolean;
}
function ResourcePreview({
  target,
  hosts,
  onClose,
  onFolder,
  standalone = false,
}: {
  target: Target;
  hosts: HostView[];
  onClose: () => void;
  onFolder: (hostId: string, path: string) => void;
  standalone?: boolean;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState("");
  const [previewCwd, setPreviewCwd] = useState(target.cwd || "~");
  const [folderInput, setFolderInput] = useState(target.cwd || "~");
  const [resolvedBase, setResolvedBase] = useState("");
  const relativePath =
    !!target.path && !/^(?:[A-Za-z]:[/\\]|[/\\]|~[/\\])/.test(target.path);
  const [zoom, setZoom] = useState(1);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const [copyError, setCopyError] = useState("");
  const imageRef = useRef<HTMLImageElement>(null);
  const copyingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);
  const copyImage = async () => {
    if (copyingRef.current || !imageRef.current) return;
    copyingRef.current = true;
    setCopyState("copying");
    setCopyError("");
    try {
      await copyPreviewImage(imageRef.current);
      if (mountedRef.current) setCopyState("copied");
    } catch (error) {
      if (mountedRef.current) {
        setCopyState("failed");
        setCopyError(
          error instanceof DOMException && error.name === "SecurityError"
            ? "외부 사이트에서 이미지 복사를 허용하지 않습니다. 원본을 열어 저장해 주세요."
            : "이미지를 복사하지 못했습니다. 창을 클릭한 뒤 다시 시도하거나 다운로드해 주세요.",
        );
      }
    } finally {
      copyingRef.current = false;
    }
  };
  const sizing = usePreviewSize();
  const host = hosts.find((h) => h.id === target.hostId);
  useEffect(() => {
    if (target.url) return;
    let ignore = false;
    setError("");
    setData(null);
    (async () => {
      const base = relativePath
        ? await resolvePreviewBase(target.hostId!, previewCwd)
        : previewCwd;
      if (ignore) return null;
      setResolvedBase(base);
      if (relativePath) setFolderInput(base);
      return api<PreviewData>(
        `/hosts/${target.hostId}/files/preview?${new URLSearchParams({ path: target.path!, cwd: base })}`,
        undefined,
        "GET",
      );
    })()
      .then((d) => {
        if (!ignore && d) setData(d);
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [target, previewCwd]);
  const [svgUrl, setSvgUrl] = useState("");
  const svgPath =
    data && data.kind !== "directory" && /\.svg$/i.test(data.path)
      ? data.path
      : undefined;
  useEffect(() => {
    setSvgUrl("");
    if (!svgPath || !target.hostId) return;
    const controller = new AbortController();
    let url = "";
    void svgImageUrl(target.hostId, svgPath, controller.signal)
      .then((value) => {
        url = value;
        if (controller.signal.aborted) URL.revokeObjectURL(value);
        else setSvgUrl(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [svgPath, target.hostId]);
  const image =
    target.url ||
    svgUrl ||
    (data?.kind === "image" && !svgPath
      ? fileUrl(target.hostId!, data.path, "image")
      : undefined);
  const download =
    target.url ||
    (data && data.kind !== "directory"
      ? fileUrl(target.hostId!, data.path)
      : undefined);
  const markdown = /\.(md|markdown)$/i.test(data?.name || "");
  const documentZoom = useDocumentZoom(data?.kind === "text" && !svgPath);
  const delimited = /\.(csv|tsv)$/i.test(data?.name || "");
  return (
    <div
      className={`resource-preview-shell${standalone ? " resource-preview-standalone" : ""}`}
      style={sizing.style}
    >
      <Modal
        title={data?.name || (target.url ? "이미지 미리보기" : "파일 미리보기")}
        subtitle={
          target.url || `${host?.name || "서버"} · ${data?.path || target.path}`
        }
        onClose={onClose}
        wide
      >
        <div className="preview-window-actions">
          {!standalone && (
            <button
              className="button secondary small"
              title="별도 창으로 열어 다른 모니터로 옮기기"
              onClick={() => {
                const url = new URL(window.location.origin + "/");
                url.searchParams.set("preview", "1");
                url.hash = new URLSearchParams({
                  target: JSON.stringify({
                    ...target,
                    path: data?.path || target.path,
                    cwd: previewCwd,
                  }),
                }).toString();
                const child = window.open(
                  url.href,
                  "_blank",
                  "popup,width=1100,height=850,resizable=yes,scrollbars=yes",
                );
                if (child || window.harborDesktop) onClose();
                else
                  setError(
                    "새 창이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용해 주세요.",
                  );
              }}
            >
              <ExternalLink size={15} />새 창으로
            </button>
          )}
          <button
            className="icon-button"
            aria-label="미리보기 기본 크기"
            title="기본 크기로 되돌리기"
            onClick={sizing.reset}
          >
            <RotateCcw size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={
              sizing.maximized ? "미리보기 크기 복원" : "미리보기 최대화"
            }
            title={
              sizing.maximized ? "이전 크기로 복원" : "창에 맞게 크게 보기"
            }
            onClick={sizing.toggle}
          >
            {sizing.maximized ? (
              <Minimize2 size={16} />
            ) : (
              <Maximize2 size={16} />
            )}
          </button>
        </div>
        <div
          className="resource-preview-body"
          ref={documentZoom.ref}
          style={
            { "--document-zoom": documentZoom.percent / 100 } as CSSProperties
          }
        >
          {relativePath && (
            <form
              className="preview-base-folder"
              onSubmit={(event) => {
                event.preventDefault();
                if (folderInput.trim()) setPreviewCwd(folderInput.trim());
              }}
            >
              <label>
                상대경로 기준 폴더
                <input
                  aria-label="상대경로 기준 폴더"
                  value={folderInput}
                  onChange={(event) => setFolderInput(event.target.value)}
                />
              </label>
              <button className="button secondary small" type="submit">
                적용
              </button>
            </form>
          )}
          {relativePath && error && resolvedBase && (
            <p className="preview-copy-status">
              기준 폴더: {resolvedBase}. 문서가 다른 프로젝트에 있으면 위
              입력란에 그 프로젝트의 절대경로를 지정해 주세요.
            </p>
          )}
          {error ? (
            <div className="inline-error" role="alert">
              {error}
            </div>
          ) : image ? (
            <>
              <div className="image-view-controls">
                <button
                  className="icon-button"
                  aria-label="이미지 축소"
                  onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
                >
                  <Minus size={16} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  className="icon-button"
                  aria-label="이미지 확대"
                  onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
                >
                  <Plus size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="이미지 크기 초기화"
                  onClick={() => setZoom(1)}
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="button secondary small preview-image-copy"
                  onClick={() => void copyImage()}
                  disabled={copyState === "copying"}
                  title="이미지를 클립보드에 복사 · 이미지를 클릭한 뒤 Ctrl+C"
                >
                  <Copy size={14} />
                  {copyState === "copying"
                    ? "복사 중…"
                    : copyState === "copied"
                      ? "복사됨"
                      : "이미지 복사"}
                </button>
              </div>
              {copyState === "copied" && (
                <p className="preview-copy-status" role="status">
                  이미지를 복사했습니다. 다른 앱에 붙여넣을 수 있습니다.
                </p>
              )}
              {copyError && (
                <p className="preview-copy-error" role="alert">
                  {copyError}
                </p>
              )}
              <div
                className="image-viewer"
                tabIndex={0}
                aria-label="이미지 미리보기 · Ctrl+C로 이미지 복사"
                onPointerDown={(event) =>
                  event.currentTarget.focus({ preventScroll: true })
                }
                onCopy={(event) => {
                  if (window.getSelection()?.toString()) return;
                  event.preventDefault();
                  event.stopPropagation();
                  void copyImage();
                }}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    !event.altKey &&
                    event.key.toLowerCase() === "c" &&
                    !window.getSelection()?.toString()
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    void copyImage();
                  }
                }}
              >
                <img
                  ref={imageRef}
                  src={image}
                  alt={data?.name || "이미지 미리보기"}
                  referrerPolicy="no-referrer"
                  style={{
                    width: `${zoom * 100}%`,
                    maxWidth: zoom === 1 ? "100%" : "none",
                  }}
                  onError={() =>
                    setError(
                      "이미지를 불러올 수 없습니다. 경로와 접근 권한을 확인해 주세요.",
                    )
                  }
                />
              </div>
            </>
          ) : data?.kind === "pdf" ? (
            <iframe
              className="pdf-file-preview"
              title={`PDF 미리보기 · ${data.name}`}
              src={fileUrl(target.hostId!, data.path, "pdf")}
              referrerPolicy="no-referrer"
            />
          ) : data?.kind === "text" ? (
            <div className="text-file-preview">
              <div className="document-zoom-toolbar">
                <span>Ctrl + 마우스 휠로 글자 크기 조절</span>
                <button
                  className="button secondary small"
                  onClick={documentZoom.reset}
                  title="기본 크기로 · Ctrl+0"
                  aria-label="문서 글자 크기 초기화"
                >
                  {documentZoom.percent}%
                </button>
              </div>
              {(markdown || delimited) && (
                <div className="preview-markdown-toolbar">
                  <button
                    className="button secondary small"
                    onClick={() => setRenderMarkdown(!renderMarkdown)}
                  >
                    {renderMarkdown
                      ? "원문 보기"
                      : delimited
                        ? "표로 보기"
                        : "문서 미리보기"}
                  </button>
                </div>
              )}
              {delimited && renderMarkdown ? (
                <DelimitedPreview
                  text={data.text || ""}
                  delimiter={/\.tsv$/i.test(data.name) ? "\t" : ","}
                />
              ) : markdown && renderMarkdown ? (
                <div className="preview-markdown">
                  <Markdown
                    text={data.text || ""}
                    location={{
                      hostId: target.hostId!,
                      cwd: fileParentDirectory(data.path) || target.cwd || "",
                    }}
                  />
                </div>
              ) : (
                <pre>
                  {data.text?.split("\n").map((line, i) => (
                    <span
                      className={`preview-line ${i + 1 === target.line ? "highlighted" : ""}`}
                      key={i}
                    >
                      <span>{i + 1}</span>
                      <code>{line || " "}</code>
                    </span>
                  ))}
                </pre>
              )}
              {data.truncated && (
                <p>
                  처음 256KB만 표시합니다. 전체 내용은 다운로드해서 확인하세요.
                </p>
              )}
            </div>
          ) : data?.kind === "directory" ? (
            <div className="preview-placeholder">
              <FolderOpen size={34} />
              <p>폴더 경로입니다.</p>
              <button
                className="button primary"
                onClick={() => {
                  if (standalone) {
                    setError(
                      "폴더는 Harbor 본창의 파일 탐색기에서 열어 주세요.",
                    );
                    return;
                  }
                  onFolder(target.hostId!, data.path);
                  onClose();
                }}
              >
                파일 탐색에서 열기
              </button>
            </div>
          ) : data?.kind === "binary" ? (
            <div className="preview-placeholder">
              <File size={34} />
              <p>이 형식은 다운로드해서 열 수 있습니다.</p>
            </div>
          ) : (
            <div className="preview-placeholder">
              <LoaderCircle size={25} className="spin" />
              <p>파일을 불러오고 있습니다…</p>
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button className="button ghost" onClick={onClose}>
            닫기
          </button>
          {download && (
            <a
              className="button primary"
              href={download}
              download={data?.name}
              target={target.url ? "_blank" : undefined}
              rel="noreferrer noopener"
            >
              {target.url ? (
                <ExternalLink size={15} />
              ) : (
                <ArrowDownToLine size={15} />
              )}
              {target.url ? "원본 열기" : "다운로드"}
            </a>
          )}
        </footer>
        {!standalone && !sizing.maximized && (
          <button
            className="preview-resize-handle"
            aria-label="미리보기 크기 조절"
            title="모서리를 드래그해 크기 조절 · 방향키로 조절 · Home으로 초기화"
            {...sizing.handlers}
          >
            <Grip size={17} />
          </button>
        )}
      </Modal>
    </div>
  );
}
