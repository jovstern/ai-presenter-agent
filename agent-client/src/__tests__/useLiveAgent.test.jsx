import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { AgentApp } from '../AgentApp.jsx';

// Every createLiveSession / startCapture / createPlayer call is recorded with
// an ordered event log, so tests can assert what happened before what.
const fakes = vi.hoisted(() => ({ sessions: [], captures: [], players: [], events: [] }));

vi.mock('../liveSession.js', () => ({
  createLiveSession: vi.fn((options) => {
    const session = {
      options,
      connect: vi.fn(async () => {
        fakes.events.push('session.connect');
      }),
      disconnect: vi.fn(),
      dispose: vi.fn(),
      sendAudioFrame: vi.fn(),
    };
    fakes.sessions.push(session);
    return session;
  }),
}));

vi.mock('../audioIO.js', () => ({
  voiceSupportError: vi.fn(() => null),
  startCapture: vi.fn(() => {
    const n = fakes.captures.length;
    fakes.events.push(`startCapture#${n}`);
    const capture = {
      ready: Promise.resolve(),
      stop: vi.fn(() => fakes.events.push(`capture#${n}.stop`)),
      getLevel: () => 0,
    };
    fakes.captures.push(capture);
    return capture;
  }),
  createPlayer: vi.fn(() => {
    const n = fakes.players.length;
    const player = {
      enqueue: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(() => fakes.events.push(`player#${n}.close`)),
      getLevel: () => 0,
    };
    fakes.players.push(player);
    return player;
  }),
}));

function fakeBridge() {
  return {
    dispatchAction: vi.fn(async () => ({ success: true })),
    requestSnapshot: vi.fn(),
    onSnapshot: vi.fn(() => () => {}),
    onNavigated: vi.fn(() => () => {}),
    close: vi.fn(),
  };
}

function renderApp(bridge = fakeBridge()) {
  const utils = render(
    <StrictMode>
      <AgentApp bridge={bridge} nonce="page-nonce" workletUrl="/agent-client/capture-worklet.js" />
    </StrictMode>,
  );
  return { bridge, ...utils };
}

// The card's own controls, by the spec's names (Screens): the failure toast
// renders outside the card, in its own region, and may repeat a label.
const TALK = 'Talk to the presenter';
const card = () => screen.getByRole('complementary', { name: 'AI presenter' });
const cardButton = (name) => within(card()).getByRole('button', { name });
const statusLine = () => within(card()).getByRole('status');

async function click(name) {
  await act(async () => {
    fireEvent.click(cardButton(name));
  });
}

// Radix's toast viewport ("Notifications (F8)") and the toasts in it.
const toasts = () =>
  within(screen.getByRole('region', { name: 'Notifications (F8)' })).queryAllByRole('listitem');

function emitStatus(status, details) {
  const session = fakes.sessions.at(-1);
  act(() => session.options.onStatusChange(status, details));
}

beforeEach(() => {
  fakes.sessions.length = 0;
  fakes.captures.length = 0;
  fakes.players.length = 0;
  fakes.events.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentApp + useLiveAgent', () => {
  it('starts idle with an enabled Talk to the presenter button', () => {
    renderApp();
    expect(cardButton(TALK).disabled).toBe(false);
  });

  it('hands the page nonce from main.jsx to the live session', async () => {
    renderApp();
    await click(TALK);
    expect(fakes.sessions[0].options.nonce).toBe('page-nonce');
  });

  it('hands the worklet URL from main.jsx to the mic capture', async () => {
    const { startCapture } = await import('../audioIO.js');
    renderApp();
    await click(TALK);
    expect(startCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ workletUrl: '/agent-client/capture-worklet.js' }),
    );
  });

  it('over plain http, says voice needs https and opens no session', async () => {
    const { voiceSupportError } = await import('../audioIO.js');
    voiceSupportError.mockReturnValueOnce(
      Object.assign(new Error('insecure'), { name: 'InsecureContextError' }),
    );
    renderApp();
    await click(TALK);

    expect(fakes.sessions).toHaveLength(0);
    expect(fakes.captures).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe(
      'Voice needs a secure connection (https). Open this page over https, or on localhost.',
    );
    // Still Talk and enabled: the same button, so focus stays on it.
    expect(cardButton(TALK).disabled).toBe(false);
  });

  it('without AudioWorklet, names a browser that can capture voice', async () => {
    const { voiceSupportError } = await import('../audioIO.js');
    voiceSupportError.mockReturnValueOnce(
      Object.assign(new Error('no worklet'), { name: 'AudioUnsupportedError' }),
    );
    renderApp();
    await click(TALK);

    expect(fakes.sessions).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe(
      "This browser can't capture voice. Use a current Chrome, Edge, Firefox or Safari.",
    );
  });

  it('pressing Talk twice stops the first capture and closes the first player before the second capture starts', async () => {
    renderApp();
    // The fake session never reports a status, so the button still reads
    // Talk: the same as a double press before `connecting` renders.
    await click(TALK);
    await click(TALK);

    const stopFirst = fakes.events.indexOf('capture#0.stop');
    const closeFirst = fakes.events.indexOf('player#0.close');
    const startSecond = fakes.events.indexOf('startCapture#1');
    expect(stopFirst).toBeGreaterThanOrEqual(0);
    expect(closeFirst).toBeGreaterThanOrEqual(0);
    expect(startSecond).toBeGreaterThan(stopFirst);
    expect(startSecond).toBeGreaterThan(closeFirst);
    // One session reused; only the latest pipeline is live.
    expect(fakes.sessions).toHaveLength(1);
    expect(fakes.captures[1].stop).not.toHaveBeenCalled();
  });

  it('unmount stops the capture, closes the player and disposes the session', async () => {
    const { unmount } = renderApp();
    await click(TALK);
    const [session] = fakes.sessions;
    unmount();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
  });

  it('render → unmount → render creates a new working session over the same bridge and never closes it', async () => {
    const bridge = fakeBridge();
    const first = renderApp(bridge);
    await click(TALK);
    first.unmount();

    renderApp(bridge);
    await click(TALK);

    expect(fakes.sessions).toHaveLength(2);
    const [oldSession, newSession] = fakes.sessions;
    expect(oldSession.dispose).toHaveBeenCalled();
    expect(newSession.dispose).not.toHaveBeenCalled();
    expect(newSession.options.bridge).toBe(bridge);
    expect(newSession.connect).toHaveBeenCalledTimes(1);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it('on failed, stops the mic and player, shows the reason, and Retry connects again', async () => {
    renderApp();
    await click(TALK);
    const [session] = fakes.sessions;

    emitStatus('failed', {
      attempt: 0,
      maxAttempts: 6,
      reason: 'This page can no longer get a connection token. Reload the page to reconnect.',
    });

    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
    expect(within(card()).getByText(/Reload the page to reconnect/)).toBeTruthy();
    expect(statusLine().textContent).toMatch(/Connection lost/);

    await click('Retry');
    expect(session.connect).toHaveBeenCalledTimes(2);
  });

  it('on failed without a reason, shows no reason and no toast', async () => {
    renderApp();
    await click(TALK);
    emitStatus('failed', { attempt: 6, maxAttempts: 6 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toasts()).toHaveLength(0);
    expect(cardButton('Retry')).toBeTruthy();
  });

  it('while reconnecting, shows the attempt and an enabled End that hangs up', async () => {
    renderApp();
    await click(TALK);
    emitStatus('reconnecting', { attempt: 2, maxAttempts: 6, reason: 'closed' });

    const button = cardButton('End');
    expect(button.disabled).toBe(false);
    expect(statusLine().textContent).toBe('Reconnecting (attempt 2 of 6)…');
    // Reconnecting keeps the mic: the session will resume onto it.
    expect(fakes.captures[0].stop).not.toHaveBeenCalled();

    await click('End');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
  });

  it('while connecting, shows a pending Cancel, which disconnects', async () => {
    renderApp();
    await click(TALK);
    emitStatus('connecting');

    expect(statusLine().textContent).toBe('Connecting…');
    expect(cardButton('Cancel').dataset.pending).toBe('true');
    await click('Cancel');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
  });

  it('on a fatal token failure, offers Reload page instead of Retry', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderApp();
    await click(TALK);
    emitStatus('failed', {
      attempt: 0,
      maxAttempts: 6,
      reason: 'This page can no longer get a connection token. Reload the page to reconnect.',
      fatal: 'token',
    });

    expect(within(card()).getByText(/Reload the page/)).toBeTruthy();
    expect(statusLine().textContent).toBe("Can't connect");
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await click('Reload page');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fakes.sessions[0].connect).toHaveBeenCalledTimes(1);
  });

  // M6 T6 (M4 re-review): a reload can't fix a server with no key, so the card
  // offers no Reload page; Try again asks the server again (it works once the
  // owner has fixed the key, without losing the page).
  it('on a fatal config failure, offers Try again (no Reload page), keeping focus on the button', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderApp();
    const button = cardButton(TALK);
    button.focus();
    await click(TALK);
    emitStatus('failed', {
      attempt: 0,
      maxAttempts: 6,
      reason:
        "The server isn't configured to connect. Contact the site owner, then try again (you may need to reload the page).",
      fatal: 'config',
    });

    expect(within(card()).getByText(/Contact the site owner/)).toBeTruthy();
    // Fatal: nothing was lost, the session never connected.
    expect(statusLine().textContent).toBe("Can't connect");
    expect(within(card()).queryByRole('button', { name: 'Reload page' })).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe('Try again');
    expect(button.disabled).toBe(false);

    await click('Try again');
    expect(reload).not.toHaveBeenCalled();
    expect(fakes.sessions[0].connect).toHaveBeenCalledTimes(2);
  });

  it('keeps focus on the primary button through connecting → reconnecting → failed', async () => {
    renderApp();
    const button = cardButton(TALK);
    button.focus();
    await click(TALK);

    for (const [status, details, label] of [
      ['connecting', undefined, 'Cancel'],
      ['reconnecting', { attempt: 1, maxAttempts: 6 }, 'End'],
      [
        'failed',
        { attempt: 6, maxAttempts: 6, reason: 'Could not reconnect after 6 attempts.' },
        'Retry',
      ],
    ]) {
      emitStatus(status, details);
      expect(document.activeElement).toBe(button);
      expect(button.textContent).toBe(label);
      expect(button.disabled).toBe(false);
    }
  });

  it('ends the session when the microphone is blocked, so the guidance to press Talk is true', async () => {
    const { startCapture } = await import('../audioIO.js');
    const stop = vi.fn();
    // getUserMedia rejects after connect() has started, as in a real browser.
    startCapture.mockImplementationOnce(({ onError }) => {
      const ready = Promise.resolve().then(() =>
        onError(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })),
      );
      return { ready, stop };
    });
    renderApp();
    await click(TALK);
    const session = fakes.sessions.at(-1);
    await act(async () => {});

    expect(session.disconnect).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    emitStatus('closed');
    expect(cardButton(TALK)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Microphone blocked — allow it in the address bar and press Talk.',
    );
  });

  // I7: whatever stops the mic from starting, the agent can't hear the user,
  // so the card never shows Live while deaf: the session ends, and the alert
  // says why in the error's own words.
  it.each([
    [
      'the worklet failing to load',
      Object.assign(new Error("Unable to load a worklet's module."), { name: 'WorkletLoadError' }),
      "Voice couldn't start. Reload the page, then press Talk.",
    ],
    [
      'the browser never starting audio',
      Object.assign(new Error('The browser did not start audio in time.'), {
        name: 'AudioResumeTimeoutError',
      }),
      "Voice couldn't start: the browser kept audio paused. Press Talk to try again.",
    ],
    [
      'no microphone',
      Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }),
      'No microphone found. Connect one, then press Talk.',
    ],
    [
      'the microphone busy',
      Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' }),
      'Microphone unavailable: Could not start audio source',
    ],
  ])('ends the session when capture fails with %s', async (_name, error, text) => {
    const { startCapture } = await import('../audioIO.js');
    const stop = vi.fn();
    startCapture.mockImplementationOnce(({ onError }) => {
      const ready = Promise.resolve().then(() => onError(error));
      return { ready, stop };
    });
    renderApp();
    await click(TALK);
    const session = fakes.sessions.at(-1);
    await act(async () => {});

    expect(session.disconnect).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    emitStatus('closed');
    expect(cardButton(TALK)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(text);
  });

  it('re-announces an identical microphone error after Talk: the alert is a new node', async () => {
    const { startCapture } = await import('../audioIO.js');
    const blocked = () =>
      startCapture.mockImplementationOnce(({ onError }) => ({
        ready: Promise.resolve().then(() =>
          onError(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })),
        ),
        stop: vi.fn(),
      }));
    blocked();
    renderApp();
    await click(TALK);
    await act(async () => {});
    const first = screen.getByRole('alert');

    blocked();
    await click(TALK);
    await act(async () => {});

    const second = screen.getByRole('alert');
    expect(second.textContent).toBe(first.textContent);
    expect(second).not.toBe(first);
  });

  it('is a landmark named "AI presenter", so its transcript is inside a region', async () => {
    renderApp();
    await click(TALK);
    act(() => fakes.sessions[0].options.onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(within(card()).getByRole('region', { name: 'Transcript' }).textContent).toBe(
      'Presenter: Hello!',
    );
  });

  it("coalesces the session's fragments into turns, spacing a turn the same speaker continues", async () => {
    renderApp();
    await click(TALK);
    const { onTranscript, onTurnEnd } = fakes.sessions[0].options;
    act(() => {
      onTranscript({ role: 'agent', text: 'Hello' });
      onTranscript({ role: 'agent', text: ' there!' });
      onTurnEnd();
      onTranscript({ role: 'agent', text: 'Ask me anything.' });
      onTranscript({ role: 'user', text: 'Go to settings.' });
    });
    const lines = within(within(card()).getByRole('list')).getAllByRole('listitem');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Presenter: Hello there! Ask me anything.',
      'You: Go to settings.',
    ]);
  });

  it('shows no transcript entries, and no transcript region, until the first fragment', async () => {
    renderApp();
    await click(TALK);
    expect(screen.queryByRole('region', { name: 'Transcript' })).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);

    act(() => fakes.sessions[0].options.onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(screen.getByRole('region', { name: 'Transcript' }).textContent).toBe(
      'Presenter: Hello!',
    );
  });

  it('names the knowledge button with its visible file count, hiding the emoji from assistive tech', () => {
    renderApp();
    // Named by its content, so the visible "0" is part of the name (WCAG 2.5.3).
    const button = screen.getByRole('button', { name: 'Knowledge files: 0' });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.querySelector('[aria-hidden="true"]').textContent).toBe('📄');
  });

  it('shows End while open, and End tears the audio down', async () => {
    renderApp();
    await click(TALK);
    emitStatus('open');
    expect(statusLine().textContent).toBe('Live');
    await click('End');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
  });
});

// The failure toast (spec Screens, R20): a Radix toast, once per failure. The
// toast is the one live announcement of the reason; the card keeps the
// reason as plain text, so a screen reader hears it once.
describe('the failure toast', () => {
  const REASON = 'Could not reconnect after 6 attempts.';
  const EXHAUSTED = { attempt: 6, maxAttempts: 6, reason: REASON };

  // Every live region whose text includes `text`: role alert or status, or an
  // aria-live other than off.
  function liveRegionsWith(text) {
    return [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')].filter(
      (node) => node.getAttribute('aria-live') !== 'off' && node.textContent.includes(text),
    );
  }

  async function failOnce() {
    renderApp();
    const button = cardButton(TALK);
    button.focus();
    await click(TALK);
    emitStatus('failed', EXHAUSTED);
    return button;
  }

  it("shows the reason with the card's action, and the card the same reason as plain text", async () => {
    await failOnce();
    const [toast] = toasts();
    expect(within(toast).getByText(REASON)).toBeTruthy();
    expect(within(toast).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(toast).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(within(card()).getByText(REASON)).toBeTruthy();
    expect(within(card()).queryByRole('alert')).toBeNull();
  });

  it('announces the reason exactly once, through the toast', async () => {
    await failOnce();
    await waitFor(() => expect(liveRegionsWith(REASON)).toHaveLength(1));
    const [announcer] = liveRegionsWith(REASON);
    expect(announcer.getAttribute('aria-live')).toBe('assertive');
    // The action's alternative is announced with it, for whoever can't reach the toast in time.
    expect(announcer.textContent).toContain('Use the Retry button on the presenter card.');
    expect(card().contains(announcer)).toBe(false);
  });

  it('does not come back once closed, whatever re-renders the card', async () => {
    await failOnce();
    await act(async () => {
      fireEvent.keyDown(toasts()[0], { key: 'Escape' });
    });
    expect(toasts()).toHaveLength(0);

    act(() => fakes.sessions[0].options.onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(toasts()).toHaveLength(0);
    expect(statusLine().textContent).toBe('Connection lost');
  });

  it('closes when the status leaves failed, and a new failure shows a new toast', async () => {
    await failOnce();
    const first = toasts()[0];

    await click('Retry');
    emitStatus('connecting');
    expect(toasts()).toHaveLength(0);

    emitStatus('failed', EXHAUSTED);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).not.toBe(first);
    await waitFor(() => expect(liveRegionsWith(REASON)).toHaveLength(1));
  });

  it("names the action after the card's: Reload page for a rejected token", async () => {
    renderApp();
    await click(TALK);
    emitStatus('failed', { ...EXHAUSTED, reason: 'Reload the page to reconnect.', fatal: 'token' });
    expect(within(toasts()[0]).getByRole('button', { name: 'Reload page' })).toBeTruthy();
  });

  it("runs the card's action from the toast and leaves focus on the card's button", async () => {
    const button = await failOnce();
    const retry = within(toasts()[0]).getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(fakes.sessions[0].connect).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(button);
  });

  it("returns focus to the card's button when the toast closes with focus inside it", async () => {
    const button = await failOnce();
    const [toast] = toasts();
    toast.focus();
    await act(async () => {
      fireEvent.keyDown(toast, { key: 'Escape' });
    });
    expect(toasts()).toHaveLength(0);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe('Retry');
  });

  it("doesn't take focus when it appears", async () => {
    const button = await failOnce();
    expect(toasts()).toHaveLength(1);
    expect(document.activeElement).toBe(button);
  });

  // Radix moves Tab through the toast by comparing document.activeElement,
  // which in the shadow root is the host, so FailureToast.jsx does it: the
  // toast, its action, Dismiss, then back to the card's button, either way.
  it('walks Tab from F8 through the toast and back to the card, and Shift+Tab back again', async () => {
    const button = await failOnce();
    const viewport = within(screen.getByRole('region', { name: 'Notifications (F8)' })).getByRole(
      'list',
    );
    const [toast] = toasts();
    const action = within(toast).getByRole('button', { name: 'Retry' });
    const dismiss = within(toast).getByRole('button', { name: 'Dismiss' });

    fireEvent.keyDown(document, { key: 'F8', code: 'F8' });
    expect(document.activeElement).toBe(viewport);
    for (const next of [toast, action, dismiss, button]) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab' });
      expect(document.activeElement).toBe(next);
    }

    dismiss.focus();
    for (const previous of [action, toast, button]) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(previous);
    }
    expect(toasts()).toHaveLength(1);
  });
});
