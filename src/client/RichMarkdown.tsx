import { useContext } from "react";
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
} from "./ResourcePreview";

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
              <button
                className="markdown-image-link"
                onClick={() => open(src, source, true)}
              >
                <Image size={20} />
                <span>
                  <b>{alt || "이미지"}</b>
                  <small>클릭해서 이미지 보기</small>
                </span>
                <ExternalLink size={13} />
              </button>
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
