import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { TerminalInfo } from "../../shared/types";
import { getToken } from "../api";
import { usePreview } from "../ResourcePreview";
import IdeWorkspace from "./IdeWorkspace";
import { createIdeApi, type IdeSelection } from "./types";
import type { IdeChatAttachment } from "./IdeChatPanel";
import { quoteIdeSelection } from "./annotationBridge";
import IdeMediaPreview from "./IdeMediaPreview";
import type { ThemeName } from "../theme-palettes";

const IdeChatPanel = lazy(() => import("./IdeChatPanel"));

const editorApi = createIdeApi((path, init) =>
  fetch(path, {
    ...init,
    headers: { ...init.headers, "X-Harbor-Token": getToken() },
  }),
);

export default function DesktopIdeView({
  onFocusTerminal,
  onShowTerminal,
  onShowChat,
  terminal,
  chatOpen,
  nativeTerminal = false,
  newConversation = false,
  ...props
}: {
  terminalId: string;
  terminal?: TerminalInfo;
  hostId: string;
  hostLabel?: string;
  workspaceCwd?: string;
  theme: ThemeName;
  visible: boolean;
  chatOpen: boolean;
  nativeTerminal?: boolean;
  newConversation?: boolean;
  onFocusTerminal: (id: string) => void;
  onShowTerminal: () => void;
  onShowChat?: () => void;
}) {
  const preview = usePreview();
  const workspace = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState(32);
  const [attachment, setAttachment] = useState<IdeChatAttachment>();
  const [chatLoaded, setChatLoaded] = useState(!nativeTerminal);
  useEffect(() => {
    if (!nativeTerminal) setChatLoaded(true);
  }, [nativeTerminal]);
  async function quote(selection: IdeSelection) {
    if (selection.hostId !== props.hostId)
      throw new Error(
        "파일을 연 서버와 AI 대화 서버가 다릅니다. 서버를 다시 선택해 주세요.",
      );
    if (nativeTerminal) {
      if (selection.terminalId !== terminal?.id)
        throw new Error("파일을 연 세션을 선택한 뒤 인용해 주세요.");
      onShowChat?.();
      await quoteIdeSelection(selection);
      return;
    }
    setAttachment({ id: crypto.randomUUID(), selection });
    onShowChat?.();
  }
  return (
    <div className="desktop-ide-workspace" ref={workspace}>
      <IdeWorkspace
        {...props}
        api={editorApi}
        onQuote={quote}
        renderMedia={(file, kind, view) => (
          <IdeMediaPreview file={file} kind={kind} view={view} />
        )}
        onPreview={(file) =>
          preview(file.path, { hostId: file.hostId, cwd: file.root })
        }
      />
      {chatOpen && !nativeTerminal && (
        <div
          className="harbor-ide-chat-divider"
          role="separator"
          aria-label="편집기와 AI 채팅 너비 조절"
          aria-orientation="vertical"
          aria-valuemin={24}
          aria-valuemax={48}
          aria-valuenow={Math.round(chatWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const bounds = workspace.current?.getBoundingClientRect();
            if (bounds?.width)
              setChatWidth(
                Math.max(
                  24,
                  Math.min(
                    48,
                    ((bounds.right - event.clientX) / bounds.width) * 100,
                  ),
                ),
              );
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setChatWidth((width) =>
                Math.max(
                  24,
                  Math.min(48, width + (event.key === "ArrowLeft" ? 2 : -2)),
                ),
              );
            }
          }}
        />
      )}
      <aside
        className="harbor-ide-chat-region"
        aria-label="AI 채팅"
        hidden={!chatOpen || nativeTerminal}
        style={{ width: `${chatWidth}%` }}
      >
        {chatLoaded && (
          <Suspense
            fallback={
              <div className="harbor-ide-loading">AI 채팅을 불러오는 중…</div>
            }
          >
            <IdeChatPanel
              hostId={props.hostId}
              terminal={
                newConversation || nativeTerminal ? undefined : terminal
              }
              hostName={props.hostLabel}
              active={props.visible && chatOpen && !nativeTerminal}
              onFocusTerminal={onFocusTerminal}
              onShowTerminal={onShowTerminal}
              attachment={attachment}
              onAttachmentConsumed={(id) =>
                setAttachment((current) =>
                  current?.id === id ? undefined : current,
                )
              }
            />
          </Suspense>
        )}
      </aside>
    </div>
  );
}
