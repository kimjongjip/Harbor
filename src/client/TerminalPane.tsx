import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "./api";
import type { ServerEvent, TerminalInfo } from "../shared/types";
import { installTerminalLinks } from "./terminalLinks";
import { restoreTerminalReplay } from "./terminalReplay";
import {
  installTerminalSelection,
  writeLocalClipboard,
} from "./terminalSelection";
import {
  snapshotTerminalAnnotation,
  buildAnnotationPrompt,
  type TerminalAnnotationSnapshot,
} from "./terminalAnnotation";
import { TerminalAnnotationDialog } from "./TerminalAnnotationDialog";
import {
  attachmentReflected,
  terminalComposer,
  waitForAttachment,
} from "./terminalAttachmentQueue";
import { usePreview } from "./ResourcePreview";
import { terminalTheme, terminalColors, useTheme } from "./Theme";
import { useNotifications } from "./Notifications";
import {
  CheckCircle2,
  Copy,
  Quote,
  FileUp,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import {
  droppedTerminalFiles,
  droppedTerminalPath,
  isTerminalFileDrag,
  isTerminalPasteShortcut,
  protectTerminalFileNavigation,
  resolveTerminalUploadTarget,
  terminalImageFile,
  terminalClipboardImages,
  terminalPathForPaste,
  terminalSelectedText,
  TERMINAL_FILE_MIME,
  TERMINAL_UPLOAD_COUNT,
  TERMINAL_UPLOAD_LIMIT,
  uploadTerminalFile,
} from "./terminalClipboard";
import "./terminal-drop.css";

interface TransferItem {
  id: number;
  name: string;
  percent: number;
  status: "queued" | "uploading" | "done" | "error" | "cancelled";
  path?: string;
  pathInserted?: boolean;
  pathAcknowledged?: boolean;
  error?: string;
}

export default function TerminalPane({
  info,
  active,
  focused = active,
  terminalColorsSupported = false,
  hostName,
}: {
  info: TerminalInfo;
  active: boolean;
  focused?: boolean;
  terminalColorsSupported?: boolean;
  hostName?: string;
}) {
  const open = usePreview();
  const { theme } = useTheme();
  const { push, isServerNoticeEnabled } = useNotifications();
  const openRef = useRef(open);
  openRef.current = open;
  const [linkHint, setLinkHint] = useState("");
  const element = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const colorsRef = useRef({
    supported: terminalColorsSupported,
    colors: terminalColors(theme),
  });
  colorsRef.current = {
    supported: terminalColorsSupported,
    colors: terminalColors(theme),
  };
  const sendColorsRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const visibilityRef = useRef({ active, focused });
  visibilityRef.current = { active, focused };
  const [connected, setConnected] = useState(false);
  const infoRef = useRef(info);
  infoRef.current = info;
  const hostNameRef = useRef(hostName);
  hostNameRef.current = hostName;
  const [uploading, setUploading] = useState(false);
  const [imageStatus, setImageStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [uploadDestination, setUploadDestination] = useState("");
  const [uploadAdvice, setUploadAdvice] = useState("");
  const [copied, setCopied] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const copySelectionRef = useRef<(() => void) | null>(null);
  const quoteSelectionRef = useRef<(() => void) | null>(null);
  const [annotation, setAnnotation] =
    useState<TerminalAnnotationSnapshot | null>(null);
  const insertAnnotationRef = useRef<
    | ((
        snapshot: TerminalAnnotationSnapshot,
        question: string,
        includeContext: boolean,
      ) => string | null)
    | null
  >(null);
  const container = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<((files: File[]) => Promise<void>) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      lineHeight: 1.3,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current!);
    term.loadAddon(
      new ImageAddon({
        sixelSupport: true,
        iipSupport: true,
        pixelLimit: 4 * 1024 * 1024,
        storageLimit: 32,
        sixelSizeLimit: 4 * 1024 * 1024,
        iipSizeLimit: 2 * 1024 * 1024,
        showPlaceholder: true,
      }),
    );
    const disposeLinks = installTerminalLinks(
      term,
      (href) =>
        openRef.current(href, {
          hostId: infoRef.current.hostId,
          cwd: infoRef.current.cwd,
        }),
      setLinkHint,
    );
    termRef.current = term;
    fitRef.current = fit;
    let socket: WebSocket | undefined;
    let stopped = false;
    let replayReceived = false;
    let notificationsReady = false;
    let screenReady = false;
    let bracketedPasteSeen = false;
    const resetPasteModeEvidence = (authoritative = false) => {
      bracketedPasteSeen = authoritative;
    };
    const observePasteMode = (params: (number | number[])[]) => {
      if (params.includes(2004)) bracketedPasteSeen = true;
      return false; // Let xterm apply the actual DECSET/DECRST operation.
    };
    const pasteModeSet = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      observePasteMode,
    );
    const pasteModeReset = term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      observePasteMode,
    );
    let connectionGeneration = 0;
    let rendering = Promise.resolve();
    let needsRedraw = false;
    let repaintTimer: ReturnType<typeof setTimeout> | undefined;
    let repaintTarget: { cols: number; rows: number } | undefined;
    let lastSentSize = "";
    let imageUpload: AbortController | undefined;
    let terminalEnded = false;
    let cancellationReason = "";
    let lastComposerPaste = 0;
    let attachmentSending = false;
    let composerInputGeneration = 0;
    let statusTimeout: ReturnType<typeof setTimeout>;
    let transferDismissTimeout: ReturnType<typeof setTimeout>;
    // Newer backends record notices globally. Older backends need live local
    // parsing; a reconnect's replay must never generate fresh notifications.
    let lastOscNoticeAt = -Infinity;
    const localNotice = (value: string, osc = false) => {
      if (stopped || !notificationsReady || isServerNoticeEnabled()) return;
      const body = value
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, 1000);
      if (!body) return;
      if (osc) lastOscNoticeAt = Date.now();
      push({
        target: "terminal",
        targetId: info.id,
        title: infoRef.current.title,
        body,
      });
    };
    const osc9 = term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("4;")) localNotice(data, true);
      return true;
    });
    const osc777 = term.parser.registerOscHandler(777, (data) => {
      if (data.startsWith("notify;"))
        localNotice(data.slice(7).replaceAll(";", " · "), true);
      return true;
    });
    const bell = term.onBell(() => {
      if (Date.now() - lastOscNoticeAt >= 1000)
        localNotice(
          "터미널에서 알림을 보냈습니다. 입력이나 작업 결과를 확인하세요.",
        );
    });
    let retry: ReturnType<typeof setTimeout>;
    const send = (data: unknown) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(data));
    };
    const sendColors = () => {
      const current = colorsRef.current;
      if (current.supported && !infoRef.current.exited)
        send({ type: "terminal-colors", id: info.id, colors: current.colors });
    };
    sendColorsRef.current = sendColors;
    const imageNotice = (message: string, error = false) => {
      if (stopped) return;
      setImageStatus(message);
      clearTimeout(statusTimeout);
      statusTimeout = setTimeout(
        () => setImageStatus(""),
        error ? 10000 : 2500,
      );
      push({
        target: "terminal",
        targetId: info.id,
        title: error ? "파일 전송 확인" : "파일 전송 · 경로 붙여넣기",
        body: message,
      });
    };
    const terminalReady = () =>
      !stopped &&
      !terminalEnded &&
      !infoRef.current.exited &&
      screenReady &&
      notificationsReady &&
      socket?.readyState === WebSocket.OPEN;
    const agentPasteReady = () =>
      term.modes.bracketedPasteMode || (infoRef.current.agentKind !== "claude" && !bracketedPasteSeen);
    const pastePath = (path: string, image: boolean) => {
      if (!terminalReady()) return false;
      const nativeAgent = !!infoRef.current.agentConnected;
      const nativeImage = image && nativeAgent && infoRef.current.agentKind !== "claude" && agentPasteReady();
      const text = nativeImage
        ? terminalPathForPaste(path, true)
        : ` ${terminalPathForPaste(path, false)} `;
      // Keep each image in its own bracketed paste event for Codex's path detector.
      if (
        nativeAgent &&
        !bracketedPasteSeen &&
        !term.modes.bracketedPasteMode
      ) {
        // Old backends may have evicted DEC2004 from replay. Only an explicit
        // user attachment gets this bounded paste event; parser mode and ordinary
        // text input stay untouched. An observed disable never enters this path.
        send({
          type: "terminal-input",
          id: info.id,
          data: `\x1b[200~${text}\x1b[201~`,
        });
      } else {
        attachmentSending = true;
        try {
          term.paste(text);
        } finally {
          attachmentSending = false;
        }
      }
      if (nativeAgent && agentPasteReady()) lastComposerPaste = Date.now();
      return true;
    };
    const pasteFiles = async (files: File[]) => {
      if (!files.length || stopped) return;
      if (imageUpload) {
        imageNotice("현재 파일 전송이 끝난 뒤 다시 올려 주세요.", true);
        return;
      }
      if (files.length > TERMINAL_UPLOAD_COUNT) {
        imageNotice(
          `파일은 한 번에 ${TERMINAL_UPLOAD_COUNT}개까지 올릴 수 있습니다.`,
          true,
        );
        return;
      }
      if (!terminalReady()) {
        imageNotice("터미널 연결을 확인한 뒤 파일을 올려 주세요.", true);
        return;
      }
      const snapshot = {
        id: infoRef.current.id,
        terminalId: infoRef.current.id,
        hostId: infoRef.current.hostId,
        cwd: infoRef.current.cwd,
      };
      const sameTarget = () =>
        infoRef.current.id === snapshot.id &&
        infoRef.current.hostId === snapshot.hostId &&
        infoRef.current.cwd === snapshot.cwd;
      const controller = new AbortController();
      clearTimeout(transferDismissTimeout);
      imageUpload = controller;
      cancellationReason = "";
      cancelRef.current = () => {
        cancellationReason = "전송을 취소했습니다.";
        controller.abort();
      };
      const items: TransferItem[] = files.map((file, id) => ({
        id,
        name: file.name || "파일",
        percent: 0,
        status: "queued",
      }));
      const update = () => {
        if (!stopped) setTransfers(items.map((item) => ({ ...item })));
      };
      update();
      setCopied(false);
      setUploadAdvice("");
      setUploading(true);
      setUploadDestination("첨부 저장 폴더 확인 중…");
      clearTimeout(statusTimeout);
      setImageStatus("파일 업로드 중…");
      try {
        const target = await resolveTerminalUploadTarget(
          snapshot,
          controller.signal,
        );
        if (!stopped) setUploadDestination(target.cwd);
        for (let i = 0; i < files.length; i++) {
          const item = items[i];
          if (controller.signal.aborted || !sameTarget() || !terminalReady()) {
            controller.abort();
            break;
          }
          if (files[i].size > TERMINAL_UPLOAD_LIMIT) {
            item.status = "error";
            item.error = "파일당 512MB 제한을 초과했습니다.";
            update();
            continue;
          }
          item.status = "uploading";
          update();
          try {
            item.path = await uploadTerminalFile(
              files[i],
              target,
              controller.signal,
              (value) => {
                item.percent = value.percent;
                update();
              },
            );
            item.percent = 100;
            item.status = "done";
          } catch (error) {
            item.status = controller.signal.aborted ? "cancelled" : "error";
            item.error = controller.signal.aborted
              ? "취소됨"
              : (error as Error).message;
          }
          update();
        }
        const saved = items.filter(
          (item) => item.status === "done" && item.path,
        );
        const failed = items.filter((item) => item.status === "error");
        if (controller.signal.aborted || !sameTarget() || !terminalReady()) {
          items
            .filter(
              (item) => item.status === "queued" || item.status === "uploading",
            )
            .forEach((item) => {
              item.status = "cancelled";
            });
          update();
          imageNotice(
            `${cancellationReason || "터미널 상태가 바뀌어 전송을 중단했습니다."} ${saved.length ? `${saved.length}개는 저장되었으며 경로를 복사할 수 있습니다.` : ""} 입력창에는 경로를 넣지 않았습니다.`,
            true,
          );
          return;
        }
        const waitingForComposer =
          infoRef.current.agentConnected && !agentPasteReady();
        if (waitingForComposer && saved.length) {
          imageNotice(
            `${saved.length}개 파일을 저장했습니다. AI 입력창이 준비되면 아래에서 경로를 복사해 붙여넣으세요.${failed.length ? ` ${failed.length}개 전송 실패.` : ""}`,
            true,
          );
          return;
        }
        let inserted = 0;
        const acknowledgeBatch =
          saved.length > 1 && !!infoRef.current.agentConnected && infoRef.current.agentKind !== "claude";
        const inputGeneration = composerInputGeneration;
        const batchGeneration = connectionGeneration;
        const readComposer = () =>
          term.modes.synchronizedOutputMode
            ? null
            : terminalComposer(term.buffer.active);
        const batchReady = () =>
          !controller.signal.aborted &&
          sameTarget() &&
          terminalReady() &&
          (!acknowledgeBatch ||
            (!!infoRef.current.agentConnected &&
              agentPasteReady() &&
              composerInputGeneration === inputGeneration &&
              connectionGeneration === batchGeneration));
        const stopBatch = () => {
          if (stopped) return;
          const remaining = saved.filter((item) => !item.pathInserted).length;
          const message = `${saved.length}개 파일은 저장했습니다. Codex 입력 확인을 기다리다 경로 입력을 멈췄습니다. 이미 보낸 경로는 다시 보내지 않았습니다.${remaining ? ` 남은 ${remaining}개 경로를 아래에서 복사할 수 있습니다.` : " 입력창의 첨부 표시를 확인하세요."}`;
          setUploadAdvice(message);
          imageNotice(message, true);
          update();
        };
        if (acknowledgeBatch) setImageStatus("Codex 첨부 확인 중…");
        for (const item of saved) {
          // Codex coalesces adjacent paste events into one burst. Giving each
          // event its own turn lets its image detector examine one path at a time.
          if (infoRef.current.agentConnected && agentPasteReady()) {
            const remaining = 350 - (Date.now() - lastComposerPaste);
            if (remaining > 0)
              await new Promise((resolve) => setTimeout(resolve, remaining));
          }
          if (
            !batchReady() ||
            (infoRef.current.agentConnected && !agentPasteReady())
          ) {
            imageNotice(
              `${saved.length}개 파일은 저장했습니다. 경로 입력을 중단했습니다.${inserted ? ` ${inserted}개 경로는 이미 입력되어 있습니다.` : " 입력창에는 경로를 넣지 않았습니다."}`,
              true,
            );
            return;
          }
          const before = acknowledgeBatch
            ? await waitForAttachment({
                signal: controller.signal,
                ready: batchReady,
                read: readComposer,
              })
            : null;
          if (acknowledgeBatch && !before) {
            stopBatch();
            return;
          }
          if (!batchReady()) {
            stopBatch();
            return;
          }
          if (pastePath(item.path!, terminalImageFile(item.path!))) {
            inserted++;
            item.pathInserted = true;
            update();
          }
          if (before && item.pathInserted) {
            const reflected = await waitForAttachment({
              signal: controller.signal,
              ready: batchReady,
              read: () =>
                attachmentReflected(
                  before,
                  readComposer(),
                  item.path!,
                  terminalImageFile(item.path!),
                )
                  ? true
                  : null,
            });
            if (!reflected) {
              stopBatch();
              return;
            }
            item.pathAcknowledged = true;
            lastComposerPaste = Date.now();
            update();
          }
        }
        const hasImages = saved.some((item) => terminalImageFile(item.path!));
        const advice = !saved.length
          ? ""
          : hasImages
            ? infoRef.current.agentKind === "claude"
              ? "Claude 입력창에 저장된 이미지 경로를 넣었습니다. 경로와 질문을 확인한 뒤 Enter를 누르세요."
              : infoRef.current.agentConnected
              ? "Codex 입력창에 [Image #숫자]가 표시되면 이미지가 첨부된 것입니다. 표시를 확인한 뒤 Enter를 누르세요."
              : "이미지는 저장되었지만 Codex 연결을 확인하지 못했습니다. 지금은 경로만 입력했습니다. Codex에서 [Image #숫자] 표시를 확인하세요."
            : "내용을 확인하고 직접 Enter를 눌러 전송하세요.";
        setUploadAdvice(advice);
        imageNotice(
          saved.length
            ? `${saved.length}개 파일 저장 · 경로 입력 완료${failed.length ? ` · ${failed.length}개 실패` : ""}. ${advice}`
            : `파일을 올리지 못했습니다. 아래 실패 원인을 확인하세요.`,
          failed.length > 0,
        );
        if (saved.length === files.length && inserted === saved.length) {
          transferDismissTimeout = setTimeout(() => {
            if (stopped) return;
            setTransfers([]);
            setUploadAdvice("");
          }, 2000);
        }
      } catch (error) {
        items
          .filter(
            (item) => item.status === "queued" || item.status === "uploading",
          )
          .forEach((item) => {
            item.status = controller.signal.aborted ? "cancelled" : "error";
            item.error = controller.signal.aborted
              ? "취소됨"
              : (error as Error).message;
          });
        update();
        imageNotice(
          controller.signal.aborted
            ? cancellationReason || "파일 전송이 취소되었습니다."
            : (error as Error).message || "파일 업로드에 실패했습니다.",
          true,
        );
      } finally {
        imageUpload = undefined;
        cancelRef.current = null;
        if (!stopped) setUploading(false);
      }
    };
    uploadRef.current = pasteFiles;
    const paste = (event: ClipboardEvent) => {
      const images = terminalClipboardImages(event.clipboardData);
      if (!images.length) {
        composerInputGeneration++;
        return; // Let xterm handle ordinary text unchanged.
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteFiles(images);
    };
    const mount = element.current!;
    const disposeSelection = installTerminalSelection(mount, term, () => true);
    const selectedText = () => terminalSelectedText(mount, term.getSelection());
    let copyStatusTimeout: ReturnType<typeof setTimeout>;
    const copyFeedback = (failed = false) => {
      if (stopped) return;
      setCopyStatus(
        failed
          ? "복사하지 못했습니다. 창을 활성화한 뒤 다시 시도해 주세요."
          : "선택한 내용을 로컬 클립보드에 복사했습니다.",
      );
      clearTimeout(copyStatusTimeout);
      copyStatusTimeout = setTimeout(
        () => setCopyStatus(""),
        failed ? 6000 : 2500,
      );
    };
    const copySelected = () => {
      const text = selectedText();
      if (!text) return;
      void writeLocalClipboard(text).then(
        () => copyFeedback(),
        () => copyFeedback(true),
      );
    };
    copySelectionRef.current = copySelected;
    quoteSelectionRef.current = () => {
      const text = selectedText();
      if (!text) return;
      try {
        setAnnotation(
          snapshotTerminalAnnotation(term, text, {
            terminalId: info.id,
            hostName: hostNameRef.current || infoRef.current.hostId,
            title: infoRef.current.title,
            threadId: infoRef.current.agentSessionId || infoRef.current.resumeThreadId,
          }),
        );
      } catch (error) {
        setCopyStatus((error as Error).message);
      }
    };
    insertAnnotationRef.current = (snapshot, question, includeContext) => {
      if (snapshot.source.terminalId !== info.id)
        return "인용한 터미널과 입력 대상이 다릅니다. 원래 터미널에서 다시 열어 주세요.";
      if (!terminalReady())
        return "터미널 연결이 끊겨 입력하지 못했습니다. 질문은 그대로 유지됩니다.";
      if (!infoRef.current.agentConnected || !term.modes.bracketedPasteMode) {
        return "AI 입력창이 준비된 뒤 다시 눌러 주세요. 질문은 그대로 유지됩니다.";
      }
      let prompt: string;
      try {
        prompt = buildAnnotationPrompt(snapshot, question, includeContext);
      } catch (error) {
        return (error as Error).message;
      }
      composerInputGeneration++;
      term.paste(prompt);
      term.clearSelection();
      mount.ownerDocument.getSelection()?.removeAllRanges();
      requestAnimationFrame(() => {
        if (!stopped) term.focus();
      });
      setCopyStatus(
        "인용·출처·질문을 AI 입력창에 넣었습니다. 확인한 뒤 Enter로 보내세요.",
      );
      clearTimeout(copyStatusTimeout);
      copyStatusTimeout = setTimeout(() => setCopyStatus(""), 4000);
      return null;
    };
    const selectionChanged = () => setHasSelection(Boolean(selectedText()));
    const terminalSelection = term.onSelectionChange(selectionChanged);
    mount.ownerDocument.addEventListener("selectionchange", selectionChanged);
    // xterm deduplicates identical ranges. After clearing an annotation, selecting
    // that same text again can skip its event; reconcile once native mouseup ends.
    let selectionFrame = 0;
    const selectionFinished = () => {
      cancelAnimationFrame(selectionFrame);
      selectionFrame = requestAnimationFrame(selectionChanged);
    };
    mount.ownerDocument.addEventListener("mouseup", selectionFinished, true);
    const ownsCopyEvent = (event: Event) => {
      // Browser selection can focus the document instead of xterm's textarea.
      // An unrelated input/dialog must retain its own clipboard handling.
      if (
        event.target instanceof Element &&
        event.target.closest('input,textarea,[contenteditable="true"]') &&
        !event.target.closest(".terminal-mount")
      )
        return false;
      const browserSelection = mount.ownerDocument.getSelection();
      if (
        browserSelection &&
        !browserSelection.isCollapsed &&
        browserSelection.toString()
      )
        return Boolean(terminalSelectedText(mount, ""));
      return (
        (event.target instanceof Node && mount.contains(event.target)) ||
        (visibilityRef.current.active &&
          visibilityRef.current.focused &&
          Boolean(term.getSelection()) &&
          (event.target === mount.ownerDocument.body ||
            event.target === mount.ownerDocument.documentElement))
      );
    };
    const copyEvent = (event: ClipboardEvent) => {
      if (!ownsCopyEvent(event)) return;
      const text = selectedText();
      if (!text || !event.clipboardData) return;
      // The native Edit > Copy menu can dispatch copy without a renderer keydown.
      // Write synchronously to that trusted event and keep remote stdin untouched.
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      event.stopImmediatePropagation();
      copyFeedback();
    };
    const copyShortcut = (event: KeyboardEvent) => {
      if (!ownsCopyEvent(event)) return;
      if (
        event.key.toLowerCase() !== "c" ||
        event.altKey ||
        (!event.ctrlKey && !event.metaKey)
      )
        return;
      if (!selectedText() && !event.shiftKey) return; // Ordinary Ctrl+C remains SIGINT.
      event.preventDefault();
      event.stopImmediatePropagation();
      copySelected();
    };
    mount.ownerDocument.addEventListener("copy", copyEvent, true);
    mount.ownerDocument.addEventListener("keydown", copyShortcut, true);
    const pasteShortcut = (event: KeyboardEvent) => {
      if (!isTerminalPasteShortcut(event)) return;
      // xterm otherwise sends Ctrl+V as 0x16 and cancels Chromium's paste.
      // Keep the browser default so trusted clipboard image/text data arrives
      // locally; a remote CLI must never try to read its server's clipboard.
      event.stopImmediatePropagation();
    };
    mount.addEventListener("keydown", pasteShortcut, true);
    // Capture before xterm's textarea listener, which only reads text/plain.
    mount.addEventListener("paste", paste, true);
    const pane = container.current!;
    let dragDepth = 0;
    const dragEnter = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth++;
      setDragging(true);
    };
    const dragOver = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect =
          terminalReady() && !imageUpload ? "copy" : "none";
      setDragging(true);
    };
    const dragLeave = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      setDragging(false);
      try {
        const transfer = event.dataTransfer!;
        if (transfer.types.includes(TERMINAL_FILE_MIME)) {
          if (!terminalReady())
            throw new Error("터미널에 연결된 뒤 파일을 놓아 주세요.");
          const path = droppedTerminalPath(transfer, infoRef.current.hostId);
          if (infoRef.current.agentConnected && !agentPasteReady())
            throw new Error("AI 입력창이 준비된 뒤 파일을 놓아 주세요.");
          pastePath(path, terminalImageFile(path));
          imageNotice(
            terminalImageFile(path) && infoRef.current.agentKind !== "claude"
              ? "이미지 경로를 입력했습니다. Codex 입력창의 [Image #숫자] 표시를 확인한 뒤 Enter를 누르세요."
              : "파일 경로를 입력했습니다. 내용을 확인하고 직접 Enter를 눌러 전송하세요.",
          );
        } else void pasteFiles(droppedTerminalFiles(transfer));
      } catch (error) {
        imageNotice((error as Error).message, true);
      }
    };
    const dragEnd = () => {
      dragDepth = 0;
      setDragging(false);
    };
    pane.addEventListener("dragenter", dragEnter, true);
    pane.addEventListener("dragover", dragOver, true);
    pane.addEventListener("dragleave", dragLeave, true);
    pane.addEventListener("drop", drop, true);
    window.addEventListener("dragend", dragEnd);
    const unprotectNavigation = protectTerminalFileNavigation();
    const sendSize = (cols: number, rows: number) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const key = `${cols}:${rows}`;
      if (key === lastSentSize) return;
      lastSentSize = key;
      send({ type: "terminal-resize", id: info.id, cols, rows });
    };
    const fittedSize = () => ({
      cols: Math.min(500, Math.max(10, term.cols)),
      rows: Math.min(200, Math.max(3, term.rows)),
    });
    const visible = () =>
      visibilityRef.current.active &&
      !!element.current?.clientWidth &&
      !!element.current?.clientHeight;
    const resize = () => {
      // Replaying cursor-addressed output at today's size corrupts the screen.
      // Both observers and visibility effects wait for the replay write barrier.
      if (!screenReady || repaintTimer || !visible()) return;
      if (!element.current?.clientWidth || !element.current?.clientHeight)
        return;
      fit.fit();
      const size = fittedSize();
      const tui =
        infoRef.current.agentConnected ||
        infoRef.current.program === "codex" ||
        infoRef.current.program === "resume" ||
        term.buffer.active.type === "alternate";
      if (needsRedraw && tui && !terminalEnded && !infoRef.current.exited) {
        needsRedraw = false;
        repaintTarget = size;
        const rows = size.rows > 3 ? size.rows - 1 : size.rows + 1;
        term.resize(size.cols, rows);
        sendSize(size.cols, rows);
        // Legacy backends have no resize history. Give the native TUI a real
        // size change so it redraws, without sending any keyboard input.
        repaintTimer = setTimeout(() => {
          repaintTimer = undefined;
          if (stopped) return;
          if (visible()) fit.fit();
          else if (repaintTarget)
            term.resize(repaintTarget.cols, repaintTarget.rows);
          const target = visible() ? fittedSize() : repaintTarget;
          repaintTarget = undefined;
          if (target) sendSize(target.cols, target.rows);
        }, 120);
      } else sendSize(size.cols, size.rows);
    };
    resizeRef.current = resize;
    const connect = () => {
      const connection = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${getToken()}`,
      );
      socket = connection;
      const generation = ++connectionGeneration;
      const current = () =>
        !stopped &&
        generation === connectionGeneration &&
        socket === connection;
      let waiting: string[] = [];
      connection.onopen = () => {
        if (!current()) return;
        setConnected(false);
        replayReceived = false;
        notificationsReady = false;
        screenReady = false;
        lastSentSize = "";
        sendColors();
        send({ type: "subscribe", sessions: [], terminals: [info.id] });
      };
      connection.onmessage = (e) => {
        if (!current()) return;
        const event: ServerEvent = JSON.parse(e.data);
        const output = (data: string) => {
          if (!notificationsReady) waiting.push(data);
          else term.write(data);
        };
        if (event.type === "terminal-data" && event.id === info.id) {
          if (!replayReceived) {
            // The first subscribed packet is always the replay, including an empty one.
            replayReceived = true;
            needsRedraw = !event.replay || !!event.replay.truncated;
            rendering = rendering
              .then(async () => {
                if (
                  !(await restoreTerminalReplay(
                    term,
                    event.data,
                    event.replay,
                    current,
                    () =>
                      resetPasteModeEvidence(event.replay?.snapshot === true),
                  ))
                )
                  return;
                notificationsReady = true;
                for (const data of waiting) term.write(data);
                waiting = [];
                // New output now follows the restored parser state. Fit only
                // after these buffered live writes, never in the middle of them.
                await new Promise<void>((resolve) => term.write("", resolve));
                if (!current()) return;
                screenReady = true;
                setConnected(true);
                resize();
              })
              .catch((error) => {
                if (!current()) return;
                push({
                  target: "terminal",
                  targetId: info.id,
                  title: "터미널 화면 복원 실패",
                  body: (error as Error).message,
                });
                connection.close();
              });
          } else output(event.data);
        }
        if (event.type === "terminal-exit" && event.id === info.id) {
          terminalEnded = true;
          cancellationReason = "터미널이 종료되어 파일 전송을 중단했습니다.";
          imageUpload?.abort();
          output(`\r\n\x1b[90m[터미널 종료: ${event.exitCode}]\x1b[0m\r\n`);
        }
        if (event.type === "error") output(`\r\n${event.message}\r\n`);
      };
      connection.onclose = () => {
        if (!current()) return;
        connectionGeneration++;
        notificationsReady = false;
        screenReady = false;
        clearTimeout(repaintTimer);
        repaintTimer = undefined;
        repaintTarget = undefined;
        cancellationReason = "터미널 연결이 끊겨 파일 전송을 중단했습니다.";
        imageUpload?.abort();
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 2000);
      };
      connection.onerror = () => connection.close();
    };
    const input = term.onData((data) => {
      // A user's edit/submit supersedes the pending attachment batch. Programmatic
      // attachment paste and terminal protocol replies do not count as edits.
      if (!attachmentSending && data && !data.startsWith("\x1b"))
        composerInputGeneration++;
      // Replaying an old capability/cursor query must not inject its answer
      // into the shell's current input line when a view reconnects.
      if (notificationsReady)
        send({ type: "terminal-input", id: info.id, data });
    });
    const composerKeys = term.onKey(() => {
      composerInputGeneration++;
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element.current!);
    connect();
    return () => {
      stopped = true;
      connectionGeneration++;
      resizeRef.current = null;
      clearTimeout(repaintTimer);
      if (repaintTarget) sendSize(repaintTarget.cols, repaintTarget.rows);
      sendColorsRef.current = null;
      uploadRef.current = null;
      imageUpload?.abort();
      cancelRef.current = null;
      clearTimeout(statusTimeout);
      clearTimeout(transferDismissTimeout);
      clearTimeout(copyStatusTimeout);
      copySelectionRef.current = null;
      quoteSelectionRef.current = null;
      insertAnnotationRef.current = null;
      disposeSelection();
      terminalSelection.dispose();
      cancelAnimationFrame(selectionFrame);
      mount.ownerDocument.removeEventListener(
        "mouseup",
        selectionFinished,
        true,
      );
      mount.ownerDocument.removeEventListener(
        "selectionchange",
        selectionChanged,
      );
      mount.ownerDocument.removeEventListener("copy", copyEvent, true);
      mount.ownerDocument.removeEventListener("keydown", copyShortcut, true);
      mount.removeEventListener("keydown", pasteShortcut, true);
      mount.removeEventListener("paste", paste, true);
      pane.removeEventListener("dragenter", dragEnter, true);
      pane.removeEventListener("dragover", dragOver, true);
      pane.removeEventListener("dragleave", dragLeave, true);
      pane.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", dragEnd);
      unprotectNavigation();
      clearTimeout(retry);
      socket?.close();
      observer.disconnect();
      input.dispose();
      composerKeys.dispose();
      osc9.dispose();
      osc777.dispose();
      bell.dispose();
      pasteModeSet.dispose();
      pasteModeReset.dispose();
      disposeLinks();
      term.dispose();
    };
  }, [info.id]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(theme);
    sendColorsRef.current?.();
  }, [theme, terminalColorsSupported]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (!visibilityRef.current.active) return;
      resizeRef.current?.();
      if (focused && visibilityRef.current.focused) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focused]);
  return (
    <div
      ref={container}
      className={`terminal-instance terminal-with-footer ${active ? "active" : ""} ${dragging ? "file-drop-active" : ""}`}
    >
      {annotation && (
        <TerminalAnnotationDialog
          annotation={annotation}
          disabled={!connected || Boolean(info.exited)}
          onClose={() => setAnnotation(null)}
          onInsert={(question, includeContext) => {
            const error = insertAnnotationRef.current
              ? insertAnnotationRef.current(
                  annotation,
                  question,
                  includeContext,
                )
              : "터미널을 사용할 수 없습니다. 질문은 그대로 유지됩니다.";
            if (!error) setAnnotation(null);
            return error;
          }}
        />
      )}
      <div className="terminal-footer">
        <span
          className="terminal-footer-status"
          role={imageStatus || copyStatus ? "status" : undefined}
          title={copyStatus || imageStatus || linkHint || undefined}
        >
          {copyStatus || imageStatus || linkHint || ""}
        </span>
        {hasSelection && (
          <button
            type="button"
            className="terminal-footer-button"
            aria-label="선택한 터미널 텍스트 복사"
            title="선택한 내용을 이 컴퓨터의 클립보드에 복사합니다 (Ctrl+C / Ctrl+Shift+C)."
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => copySelectionRef.current?.()}
          >
            <Copy size={13} /> 복사
          </button>
        )}
        {hasSelection && info.agentConnected && (
          <button
            type="button"
            className="terminal-footer-button"
            aria-label="선택한 내용 인용하여 질문"
            title="선택한 부분과 주변 문맥을 인용 카드로 열어 질문을 작성합니다."
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => quoteSelectionRef.current?.()}
          >
            <Quote size={13} /> 인용하여 질문
          </button>
        )}
        <button
          type="button"
          className="terminal-footer-button"
          aria-label="터미널에 파일 올리기"
          title="세션 전용 첨부 폴더에 저장합니다. 경로 입력 후 Enter는 직접 누르세요."
          disabled={!connected || info.exited || uploading}
          onClick={() => imageInput.current?.click()}
        >
          {uploading ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <FileUp size={13} />
          )}
          파일 첨부
        </button>
        <input
          ref={imageInput}
          type="file"
          multiple
          hidden
          data-testid={`terminal-image-${info.id}`}
          onChange={(event) => {
            void uploadRef.current?.([...(event.target.files || [])]);
            event.target.value = "";
          }}
        />
      </div>
      {!connected && <div className="terminal-connecting">터미널 연결 중…</div>}
      {dragging && (
        <div className="terminal-file-drop" role="status">
          <Upload size={30} />
          <b>
            {uploading
              ? "현재 파일 전송이 끝나면 놓아 주세요"
              : "이 터미널에 파일 놓기"}
          </b>
          <span>저장 위치 · 세션 전용 첨부 폴더</span>
          <small>
            첨부 폴더에 저장하고 경로를 입력합니다. 내용을 확인한 뒤 Enter를 누르세요.
          </small>
        </div>
      )}
      {transfers.length > 0 && (
        <section
          className="terminal-upload-panel"
          aria-label="터미널 파일 전송"
        >
          <header>
            <b>
              {uploading
                ? transfers.every(
                    (item) =>
                      item.status !== "queued" && item.status !== "uploading",
                  )
                  ? "Codex 첨부 확인 중"
                  : "파일 전송 중"
                : "파일 전송"}
            </b>
            <span>
              {transfers.filter((item) => item.status === "done").length}/
              {transfers.length}
            </span>
            <button
              type="button"
              className="icon-button compact"
              aria-label={uploading ? "파일 전송 취소" : "파일 전송 닫기"}
              onClick={() =>
                uploading ? cancelRef.current?.() : setTransfers([])
              }
            >
              <X size={14} />
            </button>
          </header>
          <div
            className="terminal-upload-destination"
            title={`첨부 저장 폴더: ${uploadDestination}`}
          >
            저장 위치 · {uploadDestination}
          </div>
          {uploadAdvice && (
            <p className="terminal-upload-advice">{uploadAdvice}</p>
          )}
          <ul>
            {transfers.map((item) => (
              <li key={item.id} className={`transfer-${item.status}`}>
                <div>
                  <span title={item.path || item.name}>{item.name}</span>
                  <small>
                    {item.status === "uploading"
                      ? `${item.percent}%`
                      : item.status === "done"
                        ? item.pathAcknowledged
                          ? "입력 확인됨"
                          : item.pathInserted
                            ? "저장됨 · 경로 보냄"
                            : "저장됨"
                        : item.status === "error"
                          ? "실패"
                          : item.status === "cancelled"
                            ? "취소됨"
                            : "대기"}
                  </small>
                </div>
                {item.status === "uploading" && (
                  <progress
                    max={100}
                    value={item.percent}
                    aria-label={`${item.name} 전송률`}
                  />
                )}
                {item.error && <p>{item.error}</p>}
              </li>
            ))}
          </ul>
          {!uploading && transfers.some((item) => item.path) && (
            <button
              type="button"
              className="terminal-copy-paths"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    transfers
                      .filter(
                        (item) =>
                          !transfers.some(
                            (value) => value.path && !value.pathInserted,
                          ) || !item.pathInserted,
                      )
                      .flatMap((item) =>
                        item.path
                          ? [terminalPathForPaste(item.path, false)]
                          : [],
                      )
                      .join(" "),
                  );
                  setCopied(true);
                } catch {
                  setImageStatus(
                    "경로를 복사하지 못했습니다. 파일 탐색기에서 저장된 파일을 확인하세요.",
                  );
                }
              }}
            >
              {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied
                ? "경로 복사됨"
                : transfers.some((item) => item.pathInserted) &&
                    transfers.some((item) => item.path && !item.pathInserted)
                  ? "남은 경로 복사"
                  : "저장된 경로 복사"}
            </button>
          )}
        </section>
      )}
      <div
        className="terminal-mount"
        ref={element}
        data-testid={`terminal-${info.id}`}
      />
    </div>
  );
}
