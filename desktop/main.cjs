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
  powerMonitor,
} = require("electron");
const { randomUUID } = require("node:crypto");
const { spawn, fork, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { backendVersionError } = require("./backend-version.cjs");
const { BackendSupervisor } = require("./backend-supervisor.cjs");
const { configureInputScheduling } = require("./input-scheduling.cjs");
const {
  DesktopUpdater,
  preparedNode,
  installationRoot,
} = require("./updater.cjs");

configureInputScheduling(app.commandLine);
app.setName("Harbor");
if (process.platform === "win32") app.setAppUserModelId("org.harbor.workspace");
if (process.env.HARBOR_DESKTOP_PROFILE)
  app.setPath("userData", path.resolve(process.env.HARBOR_DESKTOP_PROFILE));
const port = Number(process.env.HARBOR_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid HARBOR_PORT");
const origin = `http://127.0.0.1:${port}`;
const windows = new Set();
const windowDocuments = new WeakMap();
let prepared;
function discardPrepared(source) {
  if (!prepared || (source && prepared.source !== source)) return;
  const entry = prepared;
  prepared = undefined;
  clearTimeout(entry.timer);
  if (!entry.win.isDestroyed()) entry.win.destroy();
}
function prepareWorkspace(source) {
  if (quitting || prepared || !windows.has(source) || source.isDestroyed())
    return;
  const key = randomUUID();
  let win;
  try {
    win = createWindow(origin + "/", newWindowBounds({ source }), key, true);
  } catch {
    return;
  } // An optional preparation must never cancel the real drag.
  if (!win) return;
  prepared = {
    key,
    win,
    source,
    timer: setTimeout(() => discardPrepared(), 5000),
  };
  prepared.timer.unref();
}
const { WorkspaceTabs } = require("./workspace-tabs.cjs");
let workspaceTabs;
const workspaceKeys = new Map();
const detaching = new Map();
const terminalFocusRequests = new Map();
const tabDrags = new Map();
let dragEscapeRegistered = false;
function cancelTabDrag(contentsId, keepPrepared = false) {
  const drag = tabDrags.get(contentsId);
  if (drag && !keepPrepared) discardPrepared(drag.source);
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
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const defaultProject = app.isPackaged
  ? path.resolve(path.dirname(process.execPath), "../..")
  : root;
const project = installationRoot(
  root,
  defaultProject,
  process.env.HARBOR_INSTALL_ROOT,
);
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
const updater = new DesktopUpdater({
  version: expectedVersion,
  installRoot: project,
  activeRoot: root,
  changed: (state) => {
    for (const win of windows)
      if (!win.isDestroyed())
        win.webContents.send("harbor:update-state", state);
  },
  restart: async (directory, candidate) => {
    if (!backend || backend.exitCode !== null)
      throw new Error(
        "Harbor가 직접 실행한 서버에서만 자동 재시작할 수 있습니다.",
      );
    for (const win of windows) {
      if (win.isDestroyed() || !isAppPage(win.webContents.getURL())) continue;
      const dirty = await win.webContents.executeJavaScript(
        "(() => { const event = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(event); return event.defaultPrevented; })()",
      );
      if (dirty)
        throw new Error("IDE 편집 내용을 저장한 뒤 다시 시작을 눌러주세요.");
    }
    const pending = path.join(
      project,
      ".runtime",
      `update-restart-${randomUUID()}.json`,
    );
    fs.writeFileSync(
      pending,
      JSON.stringify({
        installRoot: project,
        parentPid: process.pid,
        sha: candidate.sha,
        version: candidate.version,
        dataDirectory,
        profileDirectory: app.getPath("userData"),
        port,
        previousExecutable: process.execPath,
        previousArgs: app.isPackaged ? [] : [root],
      }),
    );
    const node = await preparedNode(directory);
    const helper = fork(
      path.join(root, "desktop", "update-restart.cjs"),
      [pending],
      {
        execPath: node,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("업데이트 재시작 준비가 지연되고 있습니다.")),
          10000,
        );
        helper.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        helper.once("message", (message) => {
          clearTimeout(timer);
          message?.type === "ready"
            ? resolve()
            : reject(new Error(message?.error || "업데이트 재시작 준비 실패"));
        });
      });
    } catch (error) {
      helper.kill();
      fs.unlinkSync(pending);
      throw error;
    }
    helper.disconnect();
    helper.unref();
    requestQuit();
  },
});
// Lifecycle codes only; never include page URLs, commands or exception text.
function recordLifecycle(event, details = {}) {
  try {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const file = path.join(dataDirectory, "desktop-events.jsonl");
    try {
      if (fs.statSync(file).size > 128 * 1024)
        fs.writeFileSync(file, "", { mode: 0o600 });
    } catch {}
    fs.appendFileSync(
      file,
      JSON.stringify({ at: Date.now(), event, ...details }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* Logging must not interrupt the app. */
  }
}
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
const backendSupervisor = new BackendSupervisor({
  start: () => ensureBackend(),
  onEvent: recordLifecycle,
  onStatus: (status) => {
    for (const win of windows)
      if (!win.isDestroyed())
        win.webContents.send("harbor:backend-state", status);
  },
});
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
async function backendHealth() {
  try {
    const result = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const health = await result.json();
    return result.ok && health.ok && health.name === "codex-harbor"
      ? health
      : null;
  } catch {
    return null;
  }
}
async function healthy() {
  const health = await backendHealth();
  const error = backendVersionError(health, expectedVersion);
  if (error) throw error;
  return Boolean(health);
}
async function ensureBackend() {
  if (await healthy()) {
    if (backend && (backend.exitCode !== null || backend.signalCode !== null))
      backend = undefined;
    return backend || null;
  }
  if (quitting) throw new Error("Harbor 종료 중입니다.");
  if (backend && backend.exitCode === null && backend.signalCode === null)
    throw new Error("실행 중인 연결 프로세스의 응답을 기다리고 있습니다.");
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
  const child = backend;
  backendSupervisor.watch(child);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (quitting) throw new Error("Harbor 종료 중입니다.");
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Harbor 연결 프로세스가 종료됐습니다. ${dataDirectory}의 로그를 확인하세요.`,
      );
    if (await healthy()) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Harbor를 시작하지 못했습니다. ${dataDirectory}의 로그를 확인하세요.`,
  );
}
function showWorkspace() {
  if (quitting || !workspaceTabs) return;
  const win = [...windows].find(
    (w) => !w.isDestroyed() && workspaceKeys.get(w) === workspaceTabs.home,
  );
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (!windows.size)
    createWindow(origin + "/", undefined, workspaceTabs.home);
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
function createWindow(
  url = origin + "/",
  bounds,
  key,
  prepareOnly = false,
  waitForTab = false,
) {
  if (quitting || !isAppPage(url)) return;
  if (!key && url === origin + "/" && prepared && !prepared.win.isDestroyed()) {
    const entry = prepared;
    prepared = undefined;
    clearTimeout(entry.timer);
    const win = entry.win;
    workspaceTabs.add(entry.key);
    workspaceKeys.set(win, entry.key);
    windows.add(win);
    const requested =
      bounds || newWindowBounds({ source: BrowserWindow.getFocusedWindow() });
    win.setMinimumSize(requested.minWidth, requested.minHeight);
    win.setBounds(requested);
    win.setSkipTaskbar(false);
    const doc = windowDocuments.get(win);
    doc.waitForTab = waitForTab;
    if (doc.domReady && !waitForTab)
      win.webContents.send("harbor:activate-workspace");
    if (doc.painted && process.env.HARBOR_DESKTOP_HIDDEN !== "1") win.show();
    return win;
  }
  key ??= workspaceTabs.add();
  const target = new URL(url);
  if (key !== "main") target.searchParams.set("workspace", key);
  url = target.href;
  let initialBounds =
    bounds || newWindowBounds({ source: BrowserWindow.getFocusedWindow() });
  const saved = workspaceTabs.bounds[key];
  if (!bounds && saved) {
    const area = screen.getDisplayMatching(saved).workArea;
    const width = Math.min(
      area.width,
      Math.max(initialBounds.minWidth, saved.width),
    );
    const height = Math.min(
      area.height,
      Math.max(initialBounds.minHeight, saved.height),
    );
    initialBounds = {
      ...initialBounds,
      width,
      height,
      x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)),
    };
  }
  const win = new BrowserWindow({
    ...initialBounds,
    resizable: true,
    title: "Harbor",
    backgroundColor: "#ffffff",
    show: false,
    skipTaskbar: prepareOnly,
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      additionalArguments:
        prepareOnly || waitForTab ? ["--harbor-prepared-workspace"] : [],
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
  // A taskbar pin must follow this installation's launcher, rather than the
  // version-specific EXE that happened to be running when it was pinned.
  const launcher = path.join(project, "Start-Harbor-Desktop.ps1");
  if (process.platform === "win32" && isProject && fs.existsSync(launcher)) {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    win.setAppDetails({
      appId: "org.harbor.workspace",
      appIconPath: path.join(root, "desktop", "icon.ico"),
      relaunchCommand: `"${powershell}" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`,
      relaunchDisplayName: "Harbor",
    });
  }
  if (!prepareOnly) {
    windows.add(win);
    workspaceKeys.set(win, key);
  }
  const doc = { domReady: false, painted: false, waitForTab };
  windowDocuments.set(win, doc);
  // Register before navigation: a prepared renderer may be ready before
  // the user releases the mouse. Reloads of adopted windows also activate.
  doc.ready = new Promise((resolve, reject) => {
    win.webContents.once("dom-ready", resolve);
    win.webContents.once("did-fail-load", () =>
      reject(Error("창을 열지 못했습니다.")),
    );
    win.once("closed", () => reject(Error("창이 닫혔습니다.")));
  });
  doc.ready.catch(() => {});
  win.webContents.on("dom-ready", () => {
    doc.domReady = true;
    if ((prepareOnly || waitForTab) && !doc.waitForTab && windows.has(win))
      win.webContents.send("harbor:activate-workspace");
  });
  win.once("ready-to-show", () => {
    doc.painted = true;
    if (windows.has(win) && process.env.HARBOR_DESKTOP_HIDDEN !== "1")
      win.show();
  });
  win.on("close", (event) => {
    if (!windows.has(win)) return;
    workspaceTabs.bounds[key] = win.getNormalBounds();
    workspaceTabs.save();
    if (!quitting && windows.size === 1) {
      event.preventDefault();
      requestQuit();
    }
  });
  win.on("closed", () => {
    if (prepared?.win === win) {
      clearTimeout(prepared.timer);
      prepared = undefined;
    }
    if (!windows.has(win)) return;
    discardPrepared(win);
    windows.delete(win);
    terminalFocusRequests.delete(contentsId);
    cancelTabDrag(contentsId);
    workspaceKeys.delete(win);
    if (!quitting) workspaceTabs.close(key);
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
  win.on("unresponsive", () =>
    recordLifecycle("window-unresponsive", { windowId: win.id }),
  );
  win.on("responsive", () =>
    recordLifecycle("window-responsive", { windowId: win.id }),
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    if (prepared?.win === win) {
      discardPrepared();
      return;
    }
    recordLifecycle("renderer-exit", {
      windowId: win.id,
      reason: details.reason,
      code: details.exitCode,
    });
    cancelTabDrag(contentsId);
    if (!quitting)
      void dialog.showMessageBox(win, {
        type: "error",
        message: "화면이 중단됐습니다.",
        detail:
          "보기 메뉴의 새로고침으로 다시 연결할 수 있습니다. 서버 작업은 별도로 유지됩니다.",
      });
  });
  void win.loadURL(url).catch(() => {
    if (prepared?.win === win) discardPrepared();
  });
  return win;
}

const validTerminalId = (id) =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
function ownerWindow(id) {
  const key = workspaceTabs.owner(id);
  return [...windows].find(
    (w) => workspaceKeys.get(w) === key && !w.isDestroyed(),
  );
}
function broadcastTerminalWindows() {
  if (quitting) return;
  for (const win of windows) {
    if (win.isDestroyed() || !isAppPage(win.webContents.getURL())) continue;
    const placement = workspaceTabs.snapshot(workspaceKeys.get(win));
    win.webContents.send("harbor:workspace-tabs", placement);
    win.webContents.send("harbor:terminal-windows", placement.other);
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
async function terminalInventory() {
  const response = await fetch(origin + "/api/terminals/ids", {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("터미널 목록을 확인할 수 없습니다.");
  return (await response.json()).filter(validTerminalId);
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
function selectInWindow(win, id) {
  if (win.isMinimized()) win.restore();
  if (process.env.HARBOR_DESKTOP_HIDDEN !== "1") {
    win.show();
    win.focus();
  }
  win.webContents.send("harbor:terminal-select", id);
}
async function moveTab(id, target, before, inventory, select = true) {
  if (
    target.isDestroyed() ||
    !workspaceTabs.move(id, workspaceKeys.get(target), before, inventory)
  )
    return false;
  broadcastTerminalWindows();
  const doc = windowDocuments.get(target);
  if (doc?.waitForTab) {
    doc.waitForTab = false;
    if (doc.domReady) target.webContents.send("harbor:activate-workspace");
  }
  if (select) selectInWindow(target, id);
  return true;
}
async function detachTerminalWindow(id, source, point) {
  if (quitting || !validTerminalId(id)) return false;
  if (detaching.has(id)) return detaching.get(id);
  const task = (async () => {
    if (source.isDestroyed()) return false;
    const owner = ownerWindow(id);
    if (owner !== source) {
      if (owner) selectInWindow(owner, id);
      return !!owner;
    }
    const win = createWindow(
      origin + "/",
      popoutBounds(point, source),
      undefined,
      false,
      true,
    );
    if (!win) return false;
    try {
      await windowDocuments.get(win).ready;
      const ids = await terminalInventory();
      if (
        source.isDestroyed() ||
        ownerWindow(id) !== source ||
        quitting ||
        !ids.includes(id)
      ) {
        if (!win.isDestroyed()) win.close();
        return false;
      }
      return await moveTab(id, win, null, ids);
    } catch (error) {
      if (!win.isDestroyed()) win.close();
      throw error;
    }
  })();
  detaching.set(id, task);
  try {
    return await task;
  } finally {
    detaching.delete(id);
  }
}
function setupTerminalWindows() {
  ipcMain.on("harbor:prepare-workspace", (event) => {
    try {
      prepareWorkspace(trustedWindow(event));
    } catch {
      /* Source was closed or navigated. */
    }
  });
  ipcMain.handle("harbor:new-workspace", (event) => {
    const source = trustedWindow(event);
    return !!createWindow(origin + "/", newWindowBounds({ source }));
  });
  ipcMain.handle("harbor:update-state", (event) => {
    trustedWindow(event);
    return updater.state;
  });
  ipcMain.handle("harbor:update-check", (event) => {
    trustedWindow(event);
    if (process.platform !== "win32" || !isProject)
      return updater.publish({
        phase: "error",
        error:
          "이 설치에서는 앱 안 업데이트를 지원하지 않습니다. GitHub 설치 폴더를 이용해주세요.",
      });
    return updater.check();
  });
  ipcMain.handle("harbor:update-install", (event) => {
    trustedWindow(event);
    if (!backend)
      return updater.publish({
        phase: "error",
        error:
          "외부에서 실행한 서버에 연결되어 있어 자동 업데이트할 수 없습니다.",
      });
    return updater.install();
  });
  ipcMain.handle("harbor:update-restart", (event) => {
    trustedWindow(event);
    return updater.restart();
  });
  ipcMain.handle("harbor:backend-state", (event) => {
    trustedWindow(event);
    return backendSupervisor.status;
  });
  ipcMain.handle("harbor:backend-retry", (event) => {
    trustedWindow(event);
    return backendSupervisor.retry();
  });
  ipcMain.handle("harbor:clipboard-write-text", (event, text) => {
    trustedWindow(event);
    if (typeof text !== "string" || text.length > 4 * 1024 * 1024)
      throw new Error("Invalid clipboard text");
    clipboard.writeText(text);
    return true;
  });
  ipcMain.on("harbor:workspace-tabs", (event) => {
    event.returnValue = workspaceTabs.snapshot(
      workspaceKeys.get(trustedWindow(event)),
    );
  });
  ipcMain.handle(
    "harbor:terminal-windows",
    (event) =>
      workspaceTabs.snapshot(workspaceKeys.get(trustedWindow(event))).other,
  );
  ipcMain.handle("harbor:terminal-focus", async (event, id) => {
    const source = trustedWindow(event);
    const contentsId = source.webContents.id;
    const sequence = (terminalFocusRequests.get(contentsId) || 0) + 1;
    terminalFocusRequests.set(contentsId, sequence);
    if (!validTerminalId(id) || !(await terminalInventory()).includes(id))
      return false;
    if (
      source.isDestroyed() ||
      terminalFocusRequests.get(contentsId) !== sequence
    )
      return false;
    const win = ownerWindow(id);
    if (!win || win === source) return false;
    selectInWindow(win, id);
    return true;
  });
  ipcMain.handle("harbor:receive-tab", async (event, id, before, paneDrop) => {
    const win = trustedWindow(event);
    const drag = [...tabDrags.values()].find(
      (d) =>
        d.id === id &&
        Date.now() - d.at < 60000 &&
        d.source === ownerWindow(id),
    );
    if (
      !drag ||
      detaching.has(id) ||
      (before && (!validTerminalId(before) || ownerWindow(before) !== win))
    )
      return false;
    cancelTabDrag(drag.source.webContents.id);
    const ids = await terminalInventory();
    if (drag.source.isDestroyed() || drag.source !== ownerWindow(id))
      return false;
    return moveTab(id, win, before, ids, !paneDrop);
  });
  ipcMain.handle("harbor:terminal-detach", (event, id) =>
    detachTerminalWindow(id, trustedWindow(event)),
  );
  ipcMain.handle("harbor:tab-drag-start", async (event, id) => {
    const source = trustedWindow(event);
    if (!validTerminalId(id) || ownerWindow(id) !== source) return null;
    const token = randomUUID();
    const contentsId = event.sender.id;
    const drag = { token, id, at: Date.now(), source };
    cancelTabDrag(contentsId);
    tabDrags.set(contentsId, drag);
    prepareWorkspace(source);
    if (!dragEscapeRegistered)
      dragEscapeRegistered = globalShortcut.register("Escape", () => {
        for (const key of [...tabDrags.keys()]) cancelTabDrag(key);
      });
    drag.timeout = setTimeout(() => cancelTabDrag(contentsId), 60000);
    drag.timeout.unref();
    // Both move and detach validate the live inventory before committing.
    return token;
  });
  ipcMain.handle("harbor:tab-drag-end", async (event, token, end) => {
    const source = trustedWindow(event);
    const contentsId = event.sender.id;
    const drag = tabDrags.get(contentsId);
    if (!drag || drag.token !== token || drag.source !== source) return false;
    if (
      Date.now() - drag.at > 60000 ||
      end?.cancelled !== false ||
      (!dragEscapeRegistered && (end.nullPoint || end.buttonDown))
    ) {
      cancelTabDrag(contentsId);
      return false;
    }
    // Compare the OS pointer and window bounds in a single Electron DIP
    // coordinate space. A renderer may report dragend in the source DPI.
    const point = screen.getCursorScreenPoint();
    if (
      !outside(point, source.getBounds(), 8) ||
      [...windows].some(
        (win) =>
          win !== source &&
          !win.isDestroyed() &&
          win.isVisible() &&
          !win.isMinimized() &&
          !outside(point, win.getBounds()),
      )
    ) {
      // A different renderer may still be delivering the trusted drop.
      clearTimeout(drag.timeout);
      drag.timeout = setTimeout(() => {
        if (tabDrags.get(contentsId) === drag) cancelTabDrag(contentsId);
      }, 750);
      drag.timeout.unref();
      return false;
    }
    cancelTabDrag(contentsId, true);
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
  backendSupervisor.stop();
  setImmediate(() => app.quit());
}
function setupDesktop() {
  setupTerminalWindows();
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      // A successful creation belongs to the requesting webContents. Resuming
      // an existing session leaves it in its current window.
      if (
        details.method === "POST" &&
        details.statusCode === 200 &&
        /^\/api\/(?:terminals|hosts\/[^/]+\/history\/[^/]+\/resume)$/.test(
          new URL(details.url).pathname,
        )
      ) {
        const id = Object.entries(headers).find(
          ([name]) => name.toLowerCase() === "x-harbor-new-terminal",
        )?.[1]?.[0];
        const win = [...windows].find(
          (w) => !w.isDestroyed() && w.webContents.id === details.webContentsId,
        );
        if (
          win &&
          validTerminalId(id) &&
          workspaceTabs.created(id, workspaceKeys.get(win))
        )
          broadcastTerminalWindows();
      }
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
  discardPrepared();
  backendSupervisor.stop();
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
app
  .whenReady()
  .then(async () => {
    // Check before taking the single-instance lock: an older desktop would
    // otherwise absorb this launch and silently focus its outdated window.
    const error = backendVersionError(await backendHealth(), expectedVersion);
    if (error) throw error;
    if (!app.requestSingleInstanceLock()) {
      quitting = true;
      app.quit();
      return;
    }
    app.on("second-instance", showWorkspace);
    app.on("activate", showWorkspace);
    await ensureBackend();
    workspaceTabs = new WorkspaceTabs(dataDirectory);
    // The backend restores its durable terminals before it starts listening.
    try {
      workspaceTabs.prune(await terminalInventory());
    } catch {
      /* Retry on next startup. */
    }
    setupDesktop();
    backendSupervisor.activate();
    for (const event of ["suspend", "resume"])
      powerMonitor.on(event, () => {
        if (backend?.connected)
          backend.send(
            { type: "harbor:power", event, at: Date.now() },
            () => {},
          );
      });
    for (const key of workspaceTabs.groups.keys())
      createWindow(origin + "/", undefined, key);
  })
  .catch((error) => {
    dialog.showErrorBox("Harbor를 시작할 수 없습니다", error.message);
    quitting = true;
    app.quit();
  });
