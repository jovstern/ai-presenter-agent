import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentApp } from './AgentApp.jsx';

const HOST_ID = 'ai-presenter-agent-host';

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
      max-width: 320px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    .agent-app__status { margin-left: 8px; color: #666; }
    .agent-app__mic-error { margin-top: 8px; color: #b3261e; font-size: 0.9em; }
    .agent-app__transcript { list-style: none; margin: 8px 0 0; padding: 0; max-height: 200px; overflow-y: auto; }
    .agent-app__line { margin-bottom: 4px; }
    .agent-app__line--agent { color: #1a1a1a; }
    .agent-app__line--user { color: #555; font-style: italic; }
    .agent-app__knowledge-btn { margin-left: 8px; }
    .agent-app__knowledge-btn--empty { opacity: 0.5; box-shadow: 0 0 0 2px #b3261e inset; }

    .knowledge-modal__overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .knowledge-modal__content {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: #fff; border-radius: 8px; padding: 20px; width: 360px;
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

  createRoot(mountPoint).render(
    <StrictMode>
      <AgentApp portalContainer={portalContainer} />
    </StrictMode>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
