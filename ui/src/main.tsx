import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered after load so it never competes with the first paint. Failure is
// not worth surfacing: the app works fine without it, it just loses offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // An installed PWA can sit for days on an old bundle, so check for a new
      // one whenever it comes back to the foreground rather than on launch only.
      const check = () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", check);
      setInterval(check, 60_000);
    }).catch(() => {});

    // When a new worker takes control the page is running code that no longer
    // matches it. Reload once — guarded, because without the flag a
    // controllerchange storm becomes a reload loop.
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });
}
