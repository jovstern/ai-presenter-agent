import { createRoot } from "react-dom/client";
import AgentApp from "./AgentApp.jsx";

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
  .ds-header { display: flex; justify-content: flex-end; margin-bottom: 6px; }
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

    createRoot(mountPoint).render(<AgentApp />);
  }
}

customElements.define("ds-agent-avatar", DsAgentAvatar);
