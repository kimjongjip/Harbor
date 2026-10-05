import { useContext, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "./markdown-document.css";
import { Image, ExternalLink } from "lucide-react";
import { classifyLink, normalizeMath } from "../shared/links";
import { MermaidDiagram } from "./MermaidDiagram";
import {
  ResourceContext,
  usePreview,
  type ResourceLocation,
  fileUrl,
} from "./ResourcePreview";
import { api } from "./api";
import { resolvePreviewBase } from "./previewPath";
import { svgImageUrl } from "./svg-image";

function MarkdownImage({ src, alt, source }: { src: string; alt?: string; source?: ResourceLocation }) {
  const open = usePreview();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let objectUrl = "";
    setUrl(""); setError("");
    const link = classifyLink(src);
    if (link.kind === "web") { setUrl(link.url); return; }
    if (link.kind !== "file" || !source) { setError("이미지의 서버와 기준 폴더를 확인할 수 없습니다."); return; }
    void (async () => {
      const cwd = await resolvePreviewBase(source.hostId, source.cwd);
      const result = await api<{ kind: string; path: string }>(`/hosts/${encodeURIComponent(source.hostId)}/files/preview?${new URLSearchParams({ path: link.path, cwd })}`, undefined, "GET");
      if (/\.svg$/i.test(result.path) && result.kind !== "directory") {
        objectUrl = await svgImageUrl(source.hostId, result.path, controller.signal);
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setUrl(objectUrl);
        return;
      }
      if (result.kind !== "image") throw new Error("이미지로 미리볼 수 없는 파일입니다.");
      if (!cancelled) setUrl(fileUrl(source.hostId, result.path, "image"));
    })().catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, source?.hostId, source?.cwd]);
  return <span className="markdown-inline-image">
    {url && !error ? <img src={url} alt={alt || "이미지"} loading="lazy" referrerPolicy="no-referrer"
      tabIndex={0} role="button" title="클릭하면 새 창으로 이미지 보기"
      onClick={e => { e.stopPropagation(); open(src, source, true); }}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(src, source, true); } }}
      onError={() => setError("이미지를 불러오지 못했습니다.")} />
      : <button className="markdown-image-link" onClick={() => open(src, source, true)}>
          <Image size={20} /><span><b>{alt || "이미지"}</b><small>{error || "이미지 불러오는 중…"}</small></span><ExternalLink size={13} />
        </button>}
  </span>;
}

export function Markdown({
  text,
  location,
}: {
  text: string;
  location?: ResourceLocation;
}) {
  const inherited = useContext(ResourceContext);
  const source = location || inherited;
  const open = usePreview();
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath]}
        rehypePlugins={[
          [
            rehypeKatex,
            {
              trust: false,
              strict: "ignore",
              throwOnError: false,
              maxExpand: 1000,
              maxSize: 20,
            },
          ],
        ]}
        urlTransform={(value) =>
          classifyLink(value).kind === "blocked" ? "" : value
        }
        components={{
          pre: ({ node, children, ...props }) => {
            const child = node?.children[0];
            if (child?.type === "element" && child.tagName === "code") {
              const classes = child.properties?.className;
              if (
                Array.isArray(classes) &&
                classes.some(
                  (value) => String(value).toLowerCase() === "language-mermaid",
                )
              ) {
                const diagramSource = child.children
                  .map((part) => (part.type === "text" ? part.value : ""))
                  .join("");
                return (
                  <MermaidDiagram
                    source={diagramSource}
                    onLink={(href) => open(href, source)}
                  />
                );
              }
            }
            return <pre {...props}>{children}</pre>;
          },
          a: ({ href = "", children, ...props }) => {
            const link = classifyLink(href);
            if (link.kind === "blocked" || (link.kind === "file" && !source))
              return <span>{children}</span>;
            return (
              <a
                {...props}
                href={link.kind === "web" ? link.url : "#"}
                title={
                  link.kind === "file" ? `파일 미리보기 · ${link.path}` : href
                }
                onClick={(e) => {
                  e.preventDefault();
                  open(href, source);
                }}
                rel="noreferrer noopener"
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) =>
            typeof src === "string" && classifyLink(src).kind !== "blocked" ? (
              <MarkdownImage src={src} alt={alt} source={source} />
            ) : (
              <span>{alt || "[이미지]"}</span>
            ),
          code: ({ children, className, ...props }) => {
            const value = String(children).trim();
            const fileLike =
              !className &&
              !value.includes("\n") &&
              /(?:^[/\\]|^[A-Za-z]:[/\\]|\.[a-zA-Z]{1,8}(?::\d+(?::\d+)?)?$)/.test(
                value,
              ) &&
              classifyLink(value).kind === "file";
            return (
              <code
                {...props}
                className={`${className || ""} ${fileLike && source ? "code-file-link" : ""}`}
                title={
                  fileLike && source ? "Ctrl+클릭으로 파일 보기" : undefined
                }
                onClick={(e) => {
                  if (fileLike && source && (e.ctrlKey || e.metaKey))
                    open(value, source);
                }}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}
