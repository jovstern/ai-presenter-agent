import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentApp } from './AgentApp.jsx';
import { connectBridge } from './bridgeChannel.js';

const HOST_ID = 'ai-presenter-agent-host';

// The page nonce for /api/live-token (docs/code-review-notes.md H1). server/app.js
// templates it into this script tag's data-ds-nonce: the CSP (script-src 'self')
// rules out the inline script that used to set a window global. Read here, at the
// bundle's top level, because document.currentScript points at this tag only
// while it executes; mount() may run later, from DOMContentLoaded. This hides
// nothing from a hostile same-origin script — it can read the attribute just as
// easily — which is the residual H1 gap, not a regression.
const script = document.currentScript;
const NONCE = script instanceof HTMLScriptElement ? (script.dataset.dsNonce ?? '') : '';

function mount() {
  if (document.getElementById(HOST_ID)) return; // already mounted

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .agent-app {
      position: fixed;
      bottom: 16px;
      right: 16px;
      font-family: system-ui, sans-serif;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 12px;
      box-sizing: border-box;
      width: 320px;
      max-width: calc(100vw - 32px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    .agent-app__status { display: block; margin-top: 8px; color: #666; }
    .agent-app__mic-error, .agent-app__error { margin-top: 8px; color: #b3261e; font-size: 0.9em; }
    .agent-app__transcript { list-style: none; margin: 8px 0 0; padding: 0; max-height: 200px; overflow-y: auto; }
    .agent-app__line { margin-bottom: 4px; }
    .agent-app__line--agent { color: #1a1a1a; }
    .agent-app__line--user { color: #555; font-style: italic; }
    .agent-app__knowledge-btn { margin-left: 8px; }
    .agent-app__knowledge-btn--empty { box-shadow: 0 0 0 2px #b3261e inset; }
    /* Read by screen readers, not shown (the knowledge button's name). */
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
      overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
    }

    .knowledge-modal__overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .knowledge-modal__content {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: #fff; border-radius: 8px; padding: 20px;
      box-sizing: border-box; width: min(360px, calc(100vw - 32px));
      max-height: 80vh; overflow-y: auto; font-family: system-ui, sans-serif;
    }
    .knowledge-modal__dropzone {
      border: 2px dashed #ccc; border-radius: 6px; padding: 16px; margin: 12px 0;
      text-align: center; cursor: pointer; font-size: 0.9em; color: #666;
    }
    .knowledge-modal__dropzone--active { border-color: #1a1a1a; color: #1a1a1a; }
    .knowledge-modal__error { color: #b3261e; font-size: 0.9em; margin-bottom: 8px; }
    .knowledge-modal__files { list-style: none; margin: 0 0 12px; padding: 0; }
    .knowledge-modal__files li { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 0.9em; }
    .knowledge-modal__rules-label { display: block; font-size: 0.9em; color: #444; }
    .knowledge-modal__rules { width: 100%; min-height: 60px; margin-top: 4px; font-family: inherit; }
    .knowledge-modal__close { margin-top: 12px; }
  `;
  shadowRoot.appendChild(style);

  const mountPoint = document.createElement('div');
  shadowRoot.appendChild(mountPoint);

  // Radix's Dialog.Portal defaults to rendering into document.body, which
  // would silently escape this shadow root — unstyled (the <style> above
  // never reaches it) and outside the isolation the shadow root exists to
  // provide. A plain in-shadow-root portal target fixes it.
  const portalContainer = document.createElement('div');
  shadowRoot.appendChild(portalContainer);

  // Connected once, here, and never closed: sandbox/bridge.js accepts only the
  // first ds-bridge-connect for the page's lifetime (docs/adr/0001-private-bridge-channel.md),
  // so a channel closed by session disposal, a StrictMode double effect or a
  // remount could never be replaced. Connecting at mount rather than on the
  // Connect click also keeps the window in which another script could claim
  // the bridge first as small as possible.
  const bridge = connectBridge();

  // Kept so the tree can be unmounted, which runs useLiveAgent's cleanup
  // (session disposed, mic stopped, AudioContexts closed — docs/code-review-notes.md M4).
  const root = createRoot(mountPoint);
  root.render(
    <StrictMode>
      <AgentApp bridge={bridge} nonce={NONCE} portalContainer={portalContainer} />
    </StrictMode>,
  );

  // The host is a plain div that lives as long as the page, so the one real
  // end of life is the page going away. Skipped when the page enters the
  // back/forward cache (persisted), since it may be restored with the tree intact.
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) root.unmount();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
