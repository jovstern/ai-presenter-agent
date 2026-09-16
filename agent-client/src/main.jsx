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
    .agent-app__transcript { list-style: none; margin: 8px 0 0; padding: 0; max-height: 200px; overflow-y: auto; }
    .agent-app__line { margin-bottom: 4px; }
    .agent-app__line--agent { color: #1a1a1a; }
    .agent-app__line--user { color: #555; font-style: italic; }
  `;
  shadowRoot.appendChild(style);

  const mountPoint = document.createElement('div');
  shadowRoot.appendChild(mountPoint);

  createRoot(mountPoint).render(
    <StrictMode>
      <AgentApp />
    </StrictMode>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
