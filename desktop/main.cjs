const {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  session,
  ipcMain,
  screen,
  globalShortcut,
  clipboard,
} = require("electron");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

app.setName("Harbor");
if (process.env.HARBOR_DESKTOP_PROFILE)
  app.setPath("userData", path.resolve(process.env.HARBOR_DESKTOP_PROFILE));
const port = Number(process.env.HARBOR_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid HARBOR_PORT");
const origin = `http://127.0.0.1:${port}`;
const windows = new Set();
const terminalWindows = new Map();
const terminalFocusRequests = new Map();
const tabDrags = new Map();
let dragEscapeRegistered = false;
function cancelTabDrag(contentsId) {
  const drag = tabDrags.get(contentsId);
  if (drag) clearTimeout(drag.timeout);
  tabDrags.delete(contentsId);
  if (!tabDrags.size && dragEscapeRegistered) {
    globalShortcut.unregister("Escape");
    dragEscapeRegistered = false;
  }
}
let backend,
  quitting = false,
  shutdownStarted = false;
const root = app.getAppPath();
const project = app.isPackaged
  ? path.resolve(path.dirname(process.execPath), "../..")
  : root;
const isProject = (() => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"))
        .name === "codex-harbor"
    );
  } catch {
    return false;
  }
})();
const dataDirectory = path.resolve(
  process.env.HARBOR_DATA_DIR ||
    (isProject
      ? path.join(project, ".data")
      : path.join(app.getPath("userData"), "workspace")),
);
const iconPath = path.join(root, "desktop", "icon.png");
const isAppPage = (value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      url.pathname === "/" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const isWebPage = (value) => {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      value.length < 8000 &&
      !/[\x00-\x1f]/.test(value)
    );
  } catch {
    return false;
  }
};
async function healthy() {
  try {
    const result = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const health = await result.json();
    return result.ok && health.ok && health.name === "codex-harbor";
  } catch {
    return false;
  }
}
async function ensureBackend() {
  if (await healthy()) return;
  fs.mkdirSync(dataDirectory, { recursive: true });
  const script = path.join(root, "dist", "server.mjs");
  if (!fs.existsSync(script))
    throw new Error("먼저 npm run build를 실행하세요.");
  let node = path.join(
    root,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (!fs.existsSync(node)) {
    node =
      process.env.HARBOR_NODE ||
      execFileSync(
        process.platform === "win32" ? "where.exe" : "which",
        ["node"],
        { encoding: "utf8", windowsHide: true },
      )
        .trim()
        .split(/\r?\n/)[0];
  }
  const stdout = fs.openSync(
    path.join(dataDirectory, "desktop.stdout.log"),
    "a",
  );
  const stderr = fs.openSync(
    path.join(dataDirectory, "desktop.stderr.log"),
    "a",
  );
  try {
    backend = spawn(node, [script], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        HARBOR_PORT: String(port),
        HARBOR_DATA_DIR: dataDirectory,
        HARBOR_DEFAULT_CWD: isProject ? project : app.getPath("home"),
      },
      stdio: ["ignore", stdout, stderr, "ipc"],
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  let spawnError;
  backend.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null)
      throw new Error(
        `Harbor 연결 프로세스가 종료됐습니다. ${dataDirectory}의 로그를 확인하세요.`,
      );
    if (await healthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Harbor를 시작하지 못했습니다. ${dataDirectory}의 로그를 확인하세요.`,
  );
}
function showWorkspace() {
  if (quitting) return;
  const win = [...windows].find((w) => !w.isDestroyed());
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else createWindow();
}
function newWindowBounds({ terminal = false, source, point } = {}) {
  const from = source && !source.isDestroyed() ? source.getBounds() : undefined;
  // Electron's cursor, display work areas and window bounds all use DIP units.
  const display = point
    ? screen.getDisplayNearestPoint(point)
    : from
      ? screen.getDisplayMatching(from)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const minWidth = Math.min(terminal ? 480 : 720, area.width);
  const minHeight = Math.min(terminal ? 320 : 520, area.height);
  const width = Math.min(
    area.width,
    terminal
      ? 900
      : Math.max(minWidth, Math.min(1512, Math.round(area.width * 0.9))),
  );
  const height = Math.min(
    area.height,
    terminal
      ? 650
      : Math.max(minHeight, Math.min(982, Math.round(area.height * 0.9))),
  );
  const x = point
    ? point.x - 100
    : from
      ? from.x + 32
      : area.x + Math.round((area.width - width) / 2);
  const y = point
    ? point.y - 24
    : from
      ? from.y + 32
      : area.y + Math.round((area.height - height) / 2);
  return {
    width,
    height,
    minWidth,
    minHeight,
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
  };
}
function createWindow(url = origin + "/", bounds) {
  if (quitting || !isAppPage(url)) return;
  const initialBounds =
    bounds || newWindowBounds({ source: BrowserWindow.getFocusedWindow() });
  const win = new BrowserWindow({
    ...initialBounds,
    resizable: true,
    title: "Harbor",
    backgroundColor: "#ffffff",
    show: false,
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "desktop", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      plugins: new URL(url).searchParams.get("preview") === "1",
      backgroundThrottling: false,
    },
  });
  // Apply the requested outer bounds after the native menu/frame is attached.
  // This only runs at creation, never when an existing window is focused.
  win.setBounds(initialBounds);
  const contentsId = win.webContents.id;
  windows.add(win);
  win.once("ready-to-show", () => {
    if (process.env.HARBOR_DESKTOP_HIDDEN !== "1") win.show();
  });
  win.on("close", (event) => {
    if (!quitting && windows.size === 1) {
      event.preventDefault();
      requestQuit();
    }
  });
  win.on("closed", () => {
    windows.delete(win);
    terminalFocusRequests.delete(contentsId);
    cancelTabDrag(contentsId);
    for (const [id, entry] of terminalWindows) {
      if (entry.window === win) terminalWindows.delete(id);
    }
    broadcastTerminalWindows();
  });
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape") cancelTabDrag(contentsId);
  });
  win.webContents.on(
    "did-start-navigation",
    (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) cancelTabDrag(contentsId);
    },
  );
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle("Harbor");
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppPage(url)) {
      const terminalId = new URL(url).searchParams.get("terminal");
      if (terminalId)
        void detachTerminalWindow(terminalId, win).catch(() => {});
      else createWindow(url, newWindowBounds({ source: win }));
    } else if (isWebPage(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("render-process-gone", () => {
    cancelTabDrag(contentsId);
    if (!quitting)
      void dialog.showMessageBox(win, {
        type: "error",
        message: "화면이 중단됐습니다.",
        detail:
          "보기 메뉴의 새로고침으로 다시 연결할 수 있습니다. 서버 작업은 별도로 유지됩니다.",
      });
  });
  void win.loadURL(url);
  return win;
}

const validTerminalId = (id) =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const terminalWindowIds = () =>
  [...terminalWindows]
    .filter(([, entry]) => entry.ready && !entry.window.isDestroyed())
    .map(([id]) => id);
function broadcastTerminalWindows() {
  if (quitting) return;
  const ids = terminalWindowIds();
  for (const win of windows) {
    if (!win.isDestroyed() && isAppPage(win.webContents.getURL()))
      win.webContents.send("harbor:terminal-windows", ids);
  }
}
function trustedWindow(event) {
  if (
    event.senderFrame !== event.sender.mainFrame ||
    !isAppPage(event.senderFrame.url)
  )
    throw new Error("Untrusted desktop request");
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !windows.has(win) || win.isDestroyed())
    throw new Error("Unknown desktop window");
  return win;
}
async function terminalExists(id) {
  if (!validTerminalId(id)) return false;
  const response = await fetch(`${origin}/api/bootstrap`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) return false;
  const value = await response.json();
  return value.state.terminals.some((terminal) => terminal.id === id);
}
function outside(point, bounds, margin = 0) {
  return (
    point.x < bounds.x - margin ||
    point.x >= bounds.x + bounds.width + margin ||
    point.y < bounds.y - margin ||
    point.y >= bounds.y + bounds.height + margin
  );
}
function popoutBounds(point, source) {
  return newWindowBounds({ terminal: true, source, point });
}
async function detachTerminalWindow(id, source, point) {
  if (quitting || !validTerminalId(id)) return false;
  let entry = terminalWindows.get(id);
  if (entry && !entry.window.isDestroyed()) {
    await entry.loaded;
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.focus();
    entry.window.webContents.send("harbor:terminal-select", id);
    return true;
  }
  if (!(await terminalExists(id)) || source.isDestroyed() || quitting)
    return false;
  // Re-check after the backend lookup so concurrent gestures share one view.
  entry = terminalWindows.get(id);
  if (entry && !entry.window.isDestroyed()) {
    await entry.loaded;
    entry.window.show();
    entry.window.focus();
    entry.window.webContents.send("harbor:terminal-select", id);
    return true;
  }
  const win = createWindow(
    `${origin}/?terminal=${encodeURIComponent(id)}`,
    popoutBounds(point, source),
  );
  if (!win) return false;
  const loaded = new Promise((resolve, reject) => {
    const fail = () => {
      reject(new Error("터미널 창을 열지 못했습니다."));
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.once("did-finish-load", resolve);
    win.webContents.once("did-fail-load", fail);
    win.once("closed", () => reject(new Error("터미널 창이 닫혔습니다.")));
  });
  entry = { window: win, loaded, ready: false };
  terminalWindows.set(id, entry);
  try {
    await loaded;
    if (win.isDestroyed() || quitting) return false;
    entry.ready = true;
    broadcastTerminalWindows();
    win.show();
    win.focus();
    return true;
  } catch (error) {
    if (terminalWindows.get(id) === entry) terminalWindows.delete(id);
    broadcastTerminalWindows();
    throw error;
  }
}
function setupTerminalWindows() {
  ipcMain.handle("harbor:clipboard-write-text", (event, text) => {
    trustedWindow(event);
    if (typeof text !== "string" || text.length > 4 * 1024 * 1024)
      throw new Error("Invalid clipboard text");
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle("harbor:terminal-windows", (event) => {
    trustedWindow(event);
    return terminalWindowIds();
  });
  ipcMain.handle("harbor:terminal-focus", async (event, id) => {
    const source = trustedWindow(event);
    const selection = (terminalFocusRequests.get(event.sender.id) || 0) + 1;
    terminalFocusRequests.set(event.sender.id, selection);
    if (!validTerminalId(id)) return false;
    const entry = terminalWindows.get(id);
    if (entry?.ready && !entry.window.isDestroyed()) {
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show();
      entry.window.focus();
      entry.window.webContents.send("harbor:terminal-select", id);
      return true;
    }
    // A detached view is pinned to one PTY. Selecting a different attached
    // session must activate its workspace, never relabel the pinned PTY.
    if (!new URL(source.webContents.getURL()).searchParams.has("terminal"))
      return false;
    if (
      !(await terminalExists(id)) ||
      terminalFocusRequests.get(event.sender.id) !== selection ||
      source.isDestroyed() ||
      !source.isFocused() ||
      quitting
    )
      return false;
    let workspace = [...windows].find(
      (win) =>
        !win.isDestroyed() &&
        !new URL(win.webContents.getURL()).searchParams.has("terminal"),
    );
    if (!workspace) {
      workspace = createWindow(
        `${origin}/?focus=${encodeURIComponent(id)}`,
        newWindowBounds({ source }),
      );
      return Boolean(workspace);
    }
    if (workspace.isMinimized()) workspace.restore();
    workspace.webContents.send("harbor:terminal-select", id);
    workspace.show();
    workspace.focus();
    return true;
  });
  ipcMain.handle("harbor:terminal-detach", (event, id) =>
    detachTerminalWindow(id, trustedWindow(event)),
  );
  ipcMain.handle("harbor:tab-drag-start", async (event, id) => {
    const source = trustedWindow(event);
    if (!validTerminalId(id) || terminalWindows.get(id)?.window === source)
      return null;
    const point = screen.getCursorScreenPoint();
    if (outside(point, source.getBounds(), 8)) return null;
    const token = randomUUID();
    const drag = { token, id, start: point, at: Date.now(), source };
    cancelTabDrag(event.sender.id);
    tabDrags.set(event.sender.id, drag);
    // Windows' native OLE drag loop consumes Escape before DOM/Electron input
    // events. Register only for this short gesture, then release the shortcut.
    if (!dragEscapeRegistered)
      dragEscapeRegistered = globalShortcut.register("Escape", () => {
        for (const contentsId of [...tabDrags.keys()])
          cancelTabDrag(contentsId);
      });
    if (!dragEscapeRegistered) {
      cancelTabDrag(event.sender.id);
      return null;
    }
    drag.timeout = setTimeout(() => cancelTabDrag(event.sender.id), 60000);
    drag.timeout.unref();
    if (!(await terminalExists(id)) || tabDrags.get(event.sender.id) !== drag) {
      if (tabDrags.get(event.sender.id) === drag)
        cancelTabDrag(event.sender.id);
      return null;
    }
    return token;
  });
  ipcMain.handle("harbor:tab-drag-end", async (event, token, end) => {
    const source = trustedWindow(event);
    const drag = tabDrags.get(event.sender.id);
    cancelTabDrag(event.sender.id); // One-use token, including rejected/cancelled gestures.
    if (
      !drag ||
      drag.token !== token ||
      drag.source !== source ||
      Date.now() - drag.at > 60000 ||
      end?.cancelled !== false
    )
      return false;
    const point = screen.getCursorScreenPoint();
    // Coordinates come from the trusted native dragend event in preload. They
    // are cross-checked against the OS pointer and never accepted as navigation.
    if (
      !Number.isFinite(end.x) ||
      !Number.isFinite(end.y) ||
      Math.abs(end.x) > 100000 ||
      Math.abs(end.y) > 100000 ||
      (end.x === 0 && end.y === 0)
    )
      return false;
    if (Math.hypot(end.x - point.x, end.y - point.y) > 96) return false;
    if (
      !outside(point, source.getBounds(), 8) ||
      Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 24
    )
      return false;
    return detachTerminalWindow(drag.id, source, point);
  });
  ipcMain.on("harbor:tab-drag-cancel", (event, token) => {
    try {
      trustedWindow(event);
      if (tabDrags.get(event.sender.id)?.token === token)
        cancelTabDrag(event.sender.id);
    } catch {}
  });
}
function requestQuit() {
  if (quitting) return;
  quitting = true;
  setImmediate(() => app.quit());
}
function setupDesktop() {
  setupTerminalWindows();
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === "mainFrame")
        headers["Content-Security-Policy"] = [
          `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https: http:; connect-src 'self' ws://127.0.0.1:${port}; object-src 'none'; frame-src ${new URL(details.url).searchParams.get("preview") === "1" ? "'self'" : "'none'"}; base-uri 'none'`,
        ];
      callback({ responseHeaders: headers });
    },
  );
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(
        permission === "clipboard-sanitized-write" &&
          Boolean(contents && isAppPage(contents.getURL())) &&
          isAppPage(details.requestingUrl || origin + "/"),
      ),
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      permission === "clipboard-sanitized-write" &&
      requestingOrigin === origin &&
      Boolean(contents && isAppPage(contents.getURL())),
  );
  session.defaultSession.on("will-download", (event, item, contents) => {
    let url;
    try {
      url = new URL(item.getURL());
    } catch {
      event.preventDefault();
      return;
    }
    if (
      !contents ||
      !isAppPage(contents.getURL()) ||
      url.origin !== origin ||
      !/^\/api\/hosts\/[^/]+\/files\/(?:download|pdf)$/.test(url.pathname)
    ) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: "내 컴퓨터로 다운로드",
      buttonLabel: "저장",
      defaultPath: path.join(
        app.getPath("downloads"),
        path.basename(item.getFilename()),
      ),
    });
    item.on("updated", () => {
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed())
        win.setProgressBar(
          item.getTotalBytes() > 0
            ? item.getReceivedBytes() / item.getTotalBytes()
            : 2,
        );
    });
    item.once("done", (_event, status) => {
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
      if (status === "interrupted")
        void dialog.showMessageBox({
          type: "error",
          message: "다운로드가 중단됐습니다. 연결을 확인하고 다시 시도하세요.",
        });
    });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Harbor",
        submenu: [
          {
            label: "새 워크스페이스 창",
            accelerator: "CommandOrControl+Shift+N",
            click: () => createWindow(),
          },
          {
            label: "브라우저에서 열기",
            click: () => shell.openExternal(origin),
          },
          {
            label: "다운로드 폴더",
            click: () => shell.openPath(app.getPath("downloads")),
          },
          { type: "separator" },
          {
            label: "종료",
            accelerator: "CommandOrControl+Q",
            click: requestQuit,
          },
        ],
      },
      {
        label: "편집",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "보기",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
}
app.on("before-quit", (event) => {
  quitting = true;
  for (const contentsId of [...tabDrags.keys()]) cancelTabDrag(contentsId);
  if (!backend) return;
  if (backend.exitCode !== null || backend.signalCode !== null) {
    backend = undefined;
    return;
  }
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  const child = backend;
  let finished = false;
  let timeout;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    backend = undefined;
    setImmediate(() => app.quit());
  };
  child.once("exit", finish);
  // Only the child started by this desktop receives shutdown. A desktop
  // attached to an independently started web backend does not own its jobs.
  if (child.connected)
    child.send({ type: "harbor:shutdown" }, (error) => {
      if (error && !finished) child.kill();
    });
  else child.kill();
  timeout = setTimeout(() => {
    child.kill();
    timeout = setTimeout(finish, 1000);
  }, 3000);
});
app.on("window-all-closed", requestQuit);
if (!app.requestSingleInstanceLock()) {
  quitting = true;
  app.quit();
} else {
  app.on("second-instance", showWorkspace);
  app.on("activate", showWorkspace);
  app
    .whenReady()
    .then(async () => {
      await ensureBackend();
      setupDesktop();
      createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox("Harbor를 시작할 수 없습니다", error.message);
      quitting = true;
      app.quit();
    });
}
