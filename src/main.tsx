import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/archivo/wdth.css";
import "./styles.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker keeps the app on the device so it opens at once (sw/sw.js). In the built app
// only: during development the files change all the time.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const hadWorker = Boolean(navigator.serviceWorker.controller);
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Without it the app still works; it just loads from the server each time.
    });
  });
  // A new version took over while this page was open: load it the next time the page is out of
  // sight, so nothing changes under the user's hands.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadWorker) return;
    const reloadWhenHidden = () => {
      if (document.visibilityState === "hidden") window.location.reload();
    };
    document.addEventListener("visibilitychange", reloadWhenHidden);
  });
}
