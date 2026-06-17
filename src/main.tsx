import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// Webview error sink: JS errors land in the same rotating log file as the
// Rust side (~/Library/Logs), instead of vanishing. Local-only.
const logError = (msg: string) =>
  import("@tauri-apps/plugin-log").then(({ error }) => error(msg)).catch(() => {});

if ("__TAURI_INTERNALS__" in window) {
  window.addEventListener("error", (e) => {
    logError(`[js] ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logError(`[js] unhandled rejection: ${String(e.reason)}`);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Launch-flash fix: the window starts hidden (tauri.conf) and shows once the
// first React tree is committed. NOTE: hidden WKWebViews never fire
// requestAnimationFrame (no paint loop while occluded), so this must run on
// a timer — timers keep running. The 1.5s Rust fallback remains the net.
if ("__TAURI_INTERNALS__" in window) {
  setTimeout(() => {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().show())
      .catch((e) => logError(`[js] window show failed: ${e}`));
  }, 50);
}
