import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  startCapture: vi.fn(() => {
    const n = fakes.captures.length;
    fakes.events.push(`startCapture#${n}`);
    const capture = {
      ready: Promise.resolve(),
      stop: vi.fn(() => fakes.events.push(`capture#${n}.stop`)),
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
      <AgentApp bridge={bridge} nonce="page-nonce" />
    </StrictMode>,
  );
  return { bridge, ...utils };
}

async function click(name) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

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
  it('starts idle with an enabled Connect button', () => {
    renderApp();
    expect(screen.getByRole('button', { name: 'Connect' }).disabled).toBe(false);
  });

  it('hands the page nonce from main.jsx to the live session', async () => {
    renderApp();
    await click('Connect');
    expect(fakes.sessions[0].options.nonce).toBe('page-nonce');
  });

  it('pressing Connect twice stops the first capture and closes the first player before the second capture starts', async () => {
    renderApp();
    // The fake session never reports a status, so the button still reads
    // Connect: the same as a double press before `connecting` renders.
    await click('Connect');
    await click('Connect');

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
    await click('Connect');
    const [session] = fakes.sessions;
    unmount();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
  });

  it('render → unmount → render creates a new working session over the same bridge and never closes it', async () => {
    const bridge = fakeBridge();
    const first = renderApp(bridge);
    await click('Connect');
    first.unmount();

    renderApp(bridge);
    await click('Connect');

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
    await click('Connect');
    const [session] = fakes.sessions;

    emitStatus('failed', {
      attempt: 0,
      maxAttempts: 6,
      reason: 'This page can no longer get a connection token. Reload the page to reconnect.',
    });

    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Reload the page to reconnect/);
    expect(screen.getByRole('status').textContent).toMatch(/Connection lost/);

    await click('Retry');
    expect(session.connect).toHaveBeenCalledTimes(2);
  });

  it('on failed without a reason, shows no alert', async () => {
    renderApp();
    await click('Connect');
    emitStatus('failed', { attempt: 6, maxAttempts: 6 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('while reconnecting, shows the attempt and an enabled Disconnect that hangs up', async () => {
    renderApp();
    await click('Connect');
    emitStatus('reconnecting', { attempt: 2, maxAttempts: 6, reason: 'closed' });

    const button = screen.getByRole('button', { name: 'Disconnect' });
    expect(button.disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting (attempt 2 of 6)…');
    // Reconnecting keeps the mic: the session will resume onto it.
    expect(fakes.captures[0].stop).not.toHaveBeenCalled();

    await click('Disconnect');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
  });

  it('while connecting, shows Cancel, which disconnects', async () => {
    renderApp();
    await click('Connect');
    emitStatus('connecting');

    expect(screen.getByRole('status').textContent).toBe('Connecting…');
    await click('Cancel');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
  });

  it('on a fatal failure, offers Reload page instead of Retry', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderApp();
    await click('Connect');
    emitStatus('failed', {
      attempt: 0,
      maxAttempts: 6,
      reason: "The server isn't configured to connect. Contact the site owner.",
      fatal: true,
    });

    expect(screen.getByRole('alert').textContent).toMatch(/Contact the site owner/);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await click('Reload page');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fakes.sessions[0].connect).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the primary button through connecting → reconnecting → failed', async () => {
    renderApp();
    const button = screen.getByRole('button', { name: 'Connect' });
    button.focus();
    await click('Connect');

    for (const [status, details, label] of [
      ['connecting', undefined, 'Cancel'],
      ['reconnecting', { attempt: 1, maxAttempts: 6 }, 'Disconnect'],
      ['failed', { attempt: 6, maxAttempts: 6 }, 'Retry'],
    ]) {
      emitStatus(status, details);
      expect(document.activeElement).toBe(button);
      expect(button.textContent).toBe(label);
      expect(button.disabled).toBe(false);
    }
  });

  it('ends the session when the microphone is blocked, so the guidance to press Connect is true', async () => {
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
    await click('Connect');
    const session = fakes.sessions.at(-1);
    await act(async () => {});

    expect(session.disconnect).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    emitStatus('closed');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Microphone blocked — allow it in the address bar, then press Connect.',
    );
  });

  it('renders the transcript list only once it has entries', async () => {
    const { container } = renderApp();
    await click('Connect');
    expect(container.querySelector('ul')).toBeNull();

    act(() => fakes.sessions[0].options.onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(container.querySelector('ul').textContent).toBe('Hello!');
  });

  it('names the knowledge button with its file count, hiding the emoji from assistive tech', () => {
    renderApp();
    const button = screen.getByRole('button', { name: 'Knowledge files (0)' });
    expect(button.querySelector('[aria-hidden="true"]').textContent).toBe('📄');
  });

  it('shows Disconnect while open, and Disconnect tears the audio down', async () => {
    renderApp();
    await click('Connect');
    emitStatus('open');
    expect(screen.getByRole('status').textContent).toBe('Live');
    await click('Disconnect');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
  });
});
