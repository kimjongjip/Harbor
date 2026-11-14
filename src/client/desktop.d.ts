interface Window {
  harborDesktop?: {
    readonly platform: string;
    readonly version: string;
    updateState?: () => Promise<import("./UpdateButton").DesktopUpdateState>;
    checkUpdate?: () => Promise<
      import("./UpdateButton").DesktopUpdateState | null
    >;
    installUpdate?: () => Promise<
      import("./UpdateButton").DesktopUpdateState | null
    >;
    restartUpdate?: () => Promise<
      import("./UpdateButton").DesktopUpdateState | null
    >;
    onUpdateState?: (
      callback: (state: import("./UpdateButton").DesktopUpdateState) => void,
    ) => () => void;
    backendState?: () => Promise<{
      phase: "ready" | "recovering" | "failed";
      attempt: number;
      revision: number;
    }>;
    onBackendState?: (
      callback: (state: {
        phase: "ready" | "recovering" | "failed";
        attempt: number;
        revision: number;
      }) => void,
    ) => () => void;
    retryBackend?: () => Promise<unknown>;
    writeClipboardText?: (text: string) => Promise<boolean>;
    detachedTerminals: () => Promise<string[]>;
    onDetachedTerminals: (callback: (ids: string[]) => void) => () => void;
    focusTerminalWindow: (id: string) => Promise<boolean>;
    onTerminalSelection?: (callback: (id: string) => void) => () => void;
    detachTerminal: (id: string) => Promise<boolean>;
    startTabDrag: (id: string) => Promise<string | null>;
    endTabDrag: (token: string) => Promise<boolean>;
    cancelTabDrag: (token: string) => void;
  };
}
