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
      <AgentApp bridge={bridge} />
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
});

describe('AgentApp + useLiveAgent', () => {
  it('starts idle with an enabled Connect button', () => {
    renderApp();
    expect(screen.getByRole('button', { name: 'Connect' }).disabled).toBe(false);
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

  it('while reconnecting, the button is disabled and the status shows the attempt', async () => {
    renderApp();
    await click('Connect');
    emitStatus('reconnecting', { attempt: 2, maxAttempts: 6, reason: 'closed' });

    const button = screen.getByRole('button', { name: 'Retry' });
    expect(button.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting (attempt 2 of 6)…');
    // Reconnecting keeps the mic: the session will resume onto it.
    expect(fakes.captures[0].stop).not.toHaveBeenCalled();
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
