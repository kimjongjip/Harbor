import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { List, Minus, Plus } from "lucide-react";
import { Markdown } from "../RichMarkdown";
import { classifyLink, fileParentDirectory } from "../../shared/links";
import type { IdeFile } from "./types";

export const isMarkdownFile = (filename: string) =>
  /\.(?:md|markdown|mdown)$/i.test(filename);

/** Resolve document links without consulting or changing the terminal's cwd. */
export function markdownFileLink(
  href: string,
  filename: string,
): string | null {
  const target = classifyLink(href.split("#")[0]);
  if (target.kind !== "file" || !isMarkdownFile(target.path)) return null;
  if (/^(?:[/\\]|[A-Za-z]:[/\\]|~[/\\])/.test(target.path)) return target.path;
  const parent = fileParentDirectory(filename);
  const separator = parent.includes("\\") ? "\\" : "/";
  const base = /[/\\]$/.test(parent) ? parent : `${parent}${separator}`;
  return `${base}${target.path.replace(/[/\\]/g, separator)}`;
}

export type MarkdownRenderer = (
  text: string,
  file: IdeFile,
  actions: {
    openFile(href: string): boolean;
    openAnchor(anchor: string): void;
  },
) => ReactNode;

export function MarkdownReading({
  text,
  file,
  onOpenFile,
  renderMarkdown,
}: {
  text: string;
  file: IdeFile;
  onOpenFile(path: string): void;
  renderMarkdown?: MarkdownRenderer;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(() => {
    try {
      const value = Number(localStorage.getItem("harbor.ideMarkdownZoom"));
      if (value >= 60 && value <= 220) return value;
    } catch {}
    return 100;
  });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [headings, setHeadings] = useState<
    { id: string; text: string; level: number }[]
  >([]);
  useEffect(() => {
    try {
      localStorage.setItem("harbor.ideMarkdownZoom", String(percent));
    } catch {}
  }, [percent]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      setPercent((value) =>
        Math.max(60, Math.min(220, value + (event.deltaY < 0 ? 10 : -10))),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    const used = new Map<string, number>();
    const outline = [
      ...(content.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") || []),
    ].map((element) => {
      const title = element.textContent || "";
      const base =
        title
          .toLowerCase()
          .trim()
          .replace(/[^\p{L}\p{N}\s_-]/gu, "")
          .replace(/\s+/g, "-") || "heading";
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      element.id = id;
      return { id, text: title, level: Number(element.tagName.slice(1)) };
    });
    setHeadings(outline);
  }, [text, file.path, renderMarkdown]);
  function openAnchor(anchor: string) {
    let id = anchor;
    try {
      id = decodeURIComponent(anchor);
    } catch {}
    const element = [...(content.current?.querySelectorAll("[id]") || [])].find(
      (item) => item.id === id,
    );
    if (element && viewport.current)
      viewport.current.scrollTop +=
        element.getBoundingClientRect().top -
        viewport.current.getBoundingClientRect().top -
        20;
  }
  function openFile(href: string) {
    const path = markdownFileLink(href, file.path);
    if (!path) return false;
    onOpenFile(path);
    return true;
  }
  return (
    <section className="ide-reading" aria-label="Markdown 문서 읽기">
      <div className="ide-reading-controls">
        <button
          aria-label="문서 목차"
          aria-expanded={outlineOpen}
          onClick={() => setOutlineOpen((value) => !value)}
          disabled={!headings.length}
        >
          <List size={14} /> 목차
        </button>
        <span>Ctrl + 휠로 글자 크기 조절</span>
        <button
          aria-label="문서 글자 축소"
          disabled={percent <= 60}
          onClick={() => setPercent((value) => Math.max(60, value - 10))}
        >
          <Minus size={13} />
        </button>
        <button
          aria-label="문서 글자 크기 초기화"
          title="100%로 되돌리기"
          onClick={() => setPercent(100)}
        >
          {percent}%
        </button>
        <button
          aria-label="문서 글자 확대"
          disabled={percent >= 220}
          onClick={() => setPercent((value) => Math.min(220, value + 10))}
        >
          <Plus size={13} />
        </button>
      </div>
      {outlineOpen && (
        <nav className="ide-reading-outline" aria-label="Markdown 목차">
          {headings.map((heading) => (
            <button
              key={heading.id}
              style={{ paddingLeft: 12 + (heading.level - 1) * 12 }}
              onClick={() => openAnchor(heading.id)}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      )}
      <div
        className="ide-reading-scroll"
        ref={viewport}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "0") {
            event.preventDefault();
            event.stopPropagation();
            setPercent(100);
          }
        }}
        style={
          { "--ide-reading-size": `${(16 * percent) / 100}px` } as CSSProperties
        }
      >
        <div className="ide-reading-content preview-markdown" ref={content}>
          {renderMarkdown ? (
            renderMarkdown(text, file, { openFile, openAnchor })
          ) : (
            <Markdown
              text={text}
              location={{
                hostId: file.hostId,
                cwd: fileParentDirectory(file.path) || file.root,
              }}
              onFileLink={openFile}
              onAnchor={openAnchor}
            />
          )}
        </div>
      </div>
    </section>
  );
}
