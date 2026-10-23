import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";
import "./styles/views.css";
import "./styles/lyrics.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element is missing");

const params = new URLSearchParams(location.search);

if (params.has("harness")) {
  // Test-only hook for tests/browser/run-harness.mjs; never active in the desktop app.
  void import("./app/harness");
} else if (!window.cadence) {
  container.innerHTML = `
    <div style="font-family: system-ui, sans-serif; color: #f5f5f7; background: #08080b; height: 100vh; display: grid; place-items: center; padding: 40px; text-align: center;">
      <div>
        <h1 style="margin-bottom: 8px;">Cadence needs its desktop shell</h1>
        <p style="color: #9a9aa5; max-width: 460px;">This page was opened outside the Electron app, so the library and player bridge are unavailable. Start Cadence with <code>npm run dev</code> or the packaged application.</p>
      </div>
    </div>`;
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
