const { contextBridge, ipcRenderer } = require("electron");
// No filesystem, shell, credential or unrestricted IPC access is exposed to the UI.
let nativeDrag;
document.addEventListener(
  "dragstart",
  (event) => {
    const tab =
      event.target instanceof Element &&
      event.target.closest("[data-terminal-tab]");
    if (!event.isTrusted || !tab) return;
    nativeDrag = {
      id: tab.dataset.terminalTab,
      at: Date.now(),
      cancelled: false,
      ended: false,
    };
  },
  true,
);
document.addEventListener(
  "keydown",
  (event) => {
    if (event.isTrusted && event.key === "Escape" && nativeDrag) {
      nativeDrag.cancelled = true;
      if (nativeDrag.token)
        ipcRenderer.send("harbor:tab-drag-cancel", nativeDrag.token);
    }
  },
  true,
);
document.addEventListener(
  "dragend",
  (event) => {
    if (!event.isTrusted || !nativeDrag) return;
    nativeDrag.ended = true;
    nativeDrag.x = event.screenX;
    nativeDrag.y = event.screenY;
    // Chromium reports the null screen point for a cancelled native drag.
    if ((!event.screenX && !event.screenY) || event.buttons & 1)
      nativeDrag.cancelled = true;
  },
  true,
);
contextBridge.exposeInMainWorld(
  "harborDesktop",
  Object.freeze({
    platform: process.platform,
    version: "0.6.0",
    writeClipboardText: (text) =>
      navigator.userActivation.isActive
        ? ipcRenderer.invoke("harbor:clipboard-write-text", text)
        : Promise.resolve(false),
    detachedTerminals: () => ipcRenderer.invoke("harbor:terminal-windows"),
    onDetachedTerminals: (callback) => {
      const listener = (_event, ids) => callback(ids);
      ipcRenderer.on("harbor:terminal-windows", listener);
      return () =>
        ipcRenderer.removeListener("harbor:terminal-windows", listener);
    },
    focusTerminalWindow: (id) =>
      ipcRenderer.invoke("harbor:terminal-focus", id),
    onTerminalSelection: (callback) => {
      const listener = (_event, id) => callback(id);
      ipcRenderer.on("harbor:terminal-select", listener);
      return () =>
        ipcRenderer.removeListener("harbor:terminal-select", listener);
    },
    detachTerminal: (id) =>
      navigator.userActivation.isActive
        ? ipcRenderer.invoke("harbor:terminal-detach", id)
        : Promise.resolve(false),
    startTabDrag: async (id) => {
      const drag = nativeDrag;
      if (!drag || drag.id !== id || drag.ended || Date.now() - drag.at > 1000)
        return null;
      const token = await ipcRenderer.invoke("harbor:tab-drag-start", id);
      if (nativeDrag === drag) drag.token = token;
      if (drag.cancelled && token)
        ipcRenderer.send("harbor:tab-drag-cancel", token);
      return token;
    },
    endTabDrag: (token) => {
      const drag = nativeDrag;
      nativeDrag = undefined;
      if (!drag || !drag.ended || drag.token !== token)
        return Promise.resolve(false);
      return ipcRenderer.invoke("harbor:tab-drag-end", token, {
        x: drag.x,
        y: drag.y,
        cancelled: drag.cancelled,
      });
    },
    cancelTabDrag: (token) => {
      if (nativeDrag) nativeDrag.cancelled = true;
      ipcRenderer.send("harbor:tab-drag-cancel", token);
    },
  }),
);
