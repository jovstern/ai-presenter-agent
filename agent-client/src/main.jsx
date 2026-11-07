import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentApp } from './AgentApp.jsx';
import { connectBridge } from './bridgeChannel.js';
import { startClientLog } from './clientLog.js';
import styles from './styles.css?inline';

const HOST_ID = 'ai-presenter-agent-host';

// This bundle's own URL. It is an ES module (vite.config.js), loaded with
// <script type="module">, where document.currentScript is null, so its URL
// comes from import.meta.url and its tag is found by that URL.
const SCRIPT_URL = import.meta.url;
// The directory the bundle is served from: the capture worklet
// (public/capture-worklet.js) and the SDK chunk (liveSdk.js) ship next to it.
// The client log reports only errors thrown from files under it.
const BUNDLE_BASE = new URL('./', SCRIPT_URL).href;
const WORKLET_URL = new URL('capture-worklet.js', BUNDLE_BASE).href;
// The page nonce for /api/live-token (docs/code-review-notes.md H1). server/app.js
// templates it into this script tag's data-ds-nonce: the CSP (script-src 'self')
// rules out the inline script that used to set a window global. This hides
// nothing from a hostile same-origin script — it can read the attribute just as
// easily — which is the residual H1 gap, not a regression.
const script = Array.from(document.scripts).find((tag) => tag.src === SCRIPT_URL);
const NONCE = script?.dataset.dsNonce ?? '';

// Started here, once per page and before the mount, so an error while
// mounting is reported and LCP is observed from the start (spec R23).
const reportFailure = startClientLog({ nonce: NONCE, bundleBase: BUNDLE_BASE });

function mount() {
  if (document.getElementById(HOST_ID)) return; // already mounted

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });

  // One <style> holding styles.css (tokens, host positioning, the card and the
  // dialog), inlined into this bundle by Vite's ?inline (docs/code-review-notes.md L7).
  const style = document.createElement('style');
  style.textContent = styles;
  shadowRoot.appendChild(style);

  const mountPoint = document.createElement('div');
  shadowRoot.appendChild(mountPoint);

  // Radix's Dialog.Portal defaults to rendering into document.body, which
  // would silently escape this shadow root — unstyled (styles.css never
  // reaches it) and outside the isolation the shadow root exists to
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
      <AgentApp
        bridge={bridge}
        nonce={NONCE}
        workletUrl={WORKLET_URL}
        portalContainer={portalContainer}
        onFailure={reportFailure}
      />
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
