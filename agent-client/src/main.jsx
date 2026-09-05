import { createRoot } from "react-dom/client";
import AgentApp from "./AgentApp.jsx";
import { ToastProvider } from "./Toast.jsx";

// A shadow root gives this widget full style isolation from whatever's in the sandbox/target-app
// around it — no host-page CSS leaks in, and nothing in here leaks out. Because this ships as a
// single self-contained script (no separate CSS file, see vite.config.js's cssCodeSplit:false),
// the stylesheet is injected as a plain <style> tag at mount time instead of an import.
const STYLE = `
  :host { all: initial; }
  .ds-card {
    position: fixed;
    right: 20px;
    bottom: 20px;
    width: 240px;
    padding: 12px 14px;
    border-radius: 10px;
    background: #16213e;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    z-index: 999999;
  }
  .ds-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .ds-knowledge-trigger {
    border: none;
    background: #334155;
    color: #e2e8f0;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .ds-knowledge-trigger:hover { background: #475569; }
  .ds-dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 23, 0.6);
    z-index: 1000000;
  }
  .ds-dialog-content {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 320px;
    max-height: 80vh;
    overflow-y: auto;
    background: #16213e;
    color: #e2e8f0;
    border-radius: 10px;
    padding: 18px 20px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.45);
    z-index: 1000001;
  }
  .ds-dialog-title { margin: 0 0 8px; font-size: 15px; }
  .ds-dialog-description { margin: 0 0 14px; font-size: 12px; color: #94a3b8; line-height: 1.5; }
  .ds-dropzone {
    border: 1.5px dashed #475569;
    border-radius: 8px;
    padding: 20px 12px;
    text-align: center;
    font-size: 12px;
    color: #94a3b8;
    cursor: pointer;
    margin-bottom: 12px;
  }
  .ds-dropzone--active { border-color: #38bdf8; color: #e2e8f0; background: rgba(56,189,248,0.08); }
  .ds-file-list { list-style: none; margin: 0; padding: 0; }
  .ds-file-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #273349; font-size: 12px; }
  .ds-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ds-file-size { color: #64748b; }
  .ds-file-remove { background: none; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; line-height: 1; }
  .ds-file-remove:hover { color: #ef4444; }
  .ds-file-empty { color: #64748b; font-size: 12px; padding: 6px 0; }
  .ds-dialog-close {
    margin-top: 14px;
    width: 100%;
    padding: 6px 0;
    border: none;
    border-radius: 6px;
    background: #2b4c7e;
    color: white;
    font-size: 12px;
    cursor: pointer;
  }
  .ds-toast-viewport {
    position: fixed;
    bottom: 20px;
    right: 270px;
    width: 240px;
    list-style: none;
    margin: 0;
    padding: 0;
    z-index: 1000002;
  }
  .ds-toast {
    background: #16213e;
    color: #e2e8f0;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  }
  .ds-toast-description { margin: 0; }
  .ds-status { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #334155; }
  .ds-status--ready { background: #166534; }
  .ds-status--reconnecting { background: #92400e; }
  .ds-status--failed { background: #7f1d1d; }
  .ds-volume-meter {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 4px;
    height: 34px;
    margin: 8px 0;
  }
  .ds-volume-bar {
    width: 5px;
    height: 6px;
    border-radius: 3px;
    background: #38bdf8;
    transition: height 60ms linear;
  }
  .ds-transcript { max-height: 96px; overflow-y: auto; }
  .ds-line { margin: 2px 0; line-height: 1.35; }
  .ds-line--agent { color: #e2e8f0; }
  .ds-line--user { color: #94a3b8; font-style: italic; }
  .ds-retry {
    margin-top: 8px;
    width: 100%;
    padding: 6px 0;
    border: none;
    border-radius: 6px;
    background: #2b4c7e;
    color: white;
    font-size: 12px;
    cursor: pointer;
  }
`;

class DsAgentAvatar extends HTMLElement {
  connectedCallback() {
    if (this._mounted) return;
    this._mounted = true;

    const shadow = this.attachShadow({ mode: "open" });
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    shadow.appendChild(styleEl);

    const mountPoint = document.createElement("div");
    shadow.appendChild(mountPoint);

    // A dedicated node inside the shadow root for Radix's Dialog.Portal to render into — Radix
    // defaults to document.body, which would escape this widget's style isolation entirely.
    const portalContainer = document.createElement("div");
    shadow.appendChild(portalContainer);

    createRoot(mountPoint).render(
      <ToastProvider>
        <AgentApp portalContainer={portalContainer} />
      </ToastProvider>
    );
  }
}

customElements.define("ds-agent-avatar", DsAgentAvatar);
