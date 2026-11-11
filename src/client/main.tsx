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

const view =
  new URLSearchParams(location.search).get("preview") === "1" ? (
    <PreviewWindow />
  ) : (
    <App />
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
