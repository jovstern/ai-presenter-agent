import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { AgentApp } from '../AgentApp.jsx';
import { preloadLiveSdk } from '../liveSdk.js';
import { elementOf } from './defined.js';

// The card behind the knowledge dialog, mounted the way main.jsx mounts it: in
// an open shadow root, the dialog portalled into a container in that root.
// Radix's modal hides everything else with aria-hidden on document.body's
// children (hideOthers), which never reaches inside the shadow root, so the
// card makes itself inert while the dialog is open (AgentApp.jsx).

vi.mock('../liveSession.js', () => ({
  createLiveSession: vi.fn(() => ({
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    dispose: vi.fn(),
    sendAudioFrame: vi.fn(),
  })),
}));

vi.mock('../liveSdk.js', () => ({ preloadLiveSdk: vi.fn() }));

vi.mock('../audioIO.js', () => ({
  voiceSupportError: vi.fn(() => null),
  startCapture: vi.fn(),
  createPlayer: vi.fn(),
}));

const bridge = {
  dispatchAction: vi.fn(async () => ({ success: true })),
  requestSnapshot: vi.fn(),
  onSnapshot: vi.fn(() => () => {}),
  onNavigated: vi.fn(() => () => {}),
  close: vi.fn(),
};

/** @type {HTMLElement} */
let host;

function renderCard() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const wrapper = document.createElement('div');
  const mountPoint = document.createElement('div');
  const portalContainer = document.createElement('div');
  wrapper.append(mountPoint, portalContainer);
  shadowRoot.append(wrapper);
  render(
    <AgentApp
      bridge={bridge}
      nonce="page-nonce"
      workletUrl="/w.js"
      portalContainer={portalContainer}
    />,
    { container: mountPoint },
  );
  return { ui: within(wrapper), mountPoint, shadowRoot };
}

afterEach(() => {
  cleanup();
  host.remove();
  localStorage.clear();
  vi.mocked(preloadLiveSdk).mockClear();
});

describe('AgentApp', () => {
  it('makes the card and its toast region inert while the knowledge dialog is open, and restores them on close', async () => {
    const { ui, mountPoint, shadowRoot } = renderCard();
    const card = ui.getByRole('complementary', { name: 'AI presenter' });
    // Everything the card renders outside the dialog's portal: the card and
    // the toast viewport beside it.
    const layer = elementOf(mountPoint.firstElementChild, HTMLElement);
    expect(layer.contains(card)).toBe(true);
    expect(layer.querySelector('.toast-viewport')).not.toBeNull();
    expect(layer.hasAttribute('inert')).toBe(false);

    const trigger = ui.getByRole('button', { name: 'Knowledge files: 0' });
    trigger.focus();
    await act(async () => fireEvent.click(trigger));
    const dialog = ui.getByRole('dialog', { name: 'Knowledge' });
    expect(layer.hasAttribute('inert')).toBe(true);
    // The dialog itself isn't inside the inert layer.
    expect(layer.contains(dialog)).toBe(false);
    expect(dialog.closest('[inert]')).toBeNull();

    await act(async () => fireEvent.keyDown(dialog, { key: 'Escape' }));
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(layer.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(shadowRoot.activeElement).toBe(trigger));
  });

  // The SDK chunk loads on Talk (liveSdk.js); reaching for the button starts
  // it early, so it is usually in before the press and the token are.
  it('starts loading the SDK when the viewer points at or focuses Talk, not before', () => {
    const { ui } = renderCard();
    const talk = ui.getByRole('button', { name: 'Talk to the AI Presenter' });
    expect(preloadLiveSdk).not.toHaveBeenCalled();

    fireEvent.pointerEnter(talk);
    expect(preloadLiveSdk).toHaveBeenCalledTimes(1);
    fireEvent.focus(talk);
    expect(preloadLiveSdk).toHaveBeenCalledTimes(2);
  });
});
