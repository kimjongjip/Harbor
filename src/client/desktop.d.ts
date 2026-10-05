interface Window {
  harborDesktop?: {
    readonly platform: string;
    readonly version: string;
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
