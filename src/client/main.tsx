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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <NotificationsProvider>
        {new URLSearchParams(location.search).get("preview") === "1" ? (
          <PreviewWindow />
        ) : (
          <App />
        )}
      </NotificationsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
