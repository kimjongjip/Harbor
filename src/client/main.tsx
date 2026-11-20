import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PreviewWindow from "./PreviewWindow";
import "./styles.css";
import "./rich-content.css";
import "./workspace.css";
import "./themes.css";
import { ThemeProvider } from "./Theme";
import { NotificationsProvider } from "./Notifications";
import { TypographyProvider } from "./Typography";
import "./typography.css";
import { remoteDesktop } from "./desktop-session";
import DesktopConnectGate from "./DesktopConnectGate";
import {
  readBootstrap,
  type WorkspaceBootstrap,
  type WorkspaceStartup,
} from "./useHarbor";
import { setToken, setConnectionMonitoring } from "./api";

const query = new URLSearchParams(location.search);
function mount(startup?: WorkspaceStartup) {
  const view =
    query.get("preview") === "1" ? (
      <PreviewWindow />
    ) : (
      <App startup={startup} />
    );

  const workbench = (
    <ThemeProvider>
      <TypographyProvider>
        <NotificationsProvider>{view}</NotificationsProvider>
      </TypographyProvider>
    </ThemeProvider>
  );
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {remoteDesktop ? (
        <DesktopConnectGate>{workbench}</DesktopConnectGate>
      ) : (
        workbench
      )}
    </React.StrictMode>,
  );
}
async function start() {
  await window.harborDesktop?.awaitWorkspaceActivation?.();
  if (
    !window.harborDesktop ||
    !query.has("workspace") ||
    query.has("preview") ||
    remoteDesktop
  )
    return mount();
  // A new local workspace usually has its data in a few milliseconds. Mount
  // the terminal in the first render instead of building an empty workspace
  // and immediately replacing it. A slow backend still gets the normal UI.
  const request = readBootstrap(AbortSignal.timeout(12000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const data = await Promise.race([
    request.catch(() => undefined),
    new Promise<WorkspaceBootstrap | undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 80);
    }),
  ]);
  clearTimeout(timer);
  if (data) {
    setToken(data.token);
    setConnectionMonitoring(!!data.capabilities?.connectionMonitoring);
  }
  mount({ current: { data, request } });
}
void start();
