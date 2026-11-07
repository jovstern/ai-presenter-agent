import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { AgentApp } from '../AgentApp.jsx';
import { startCapture, voiceSupportError } from '../audioIO.js';
import { defined, elementOf } from './defined.js';

/**
 * @import { Mock } from 'vitest'
 * @import { LiveSessionOptions, SessionStatus, StatusDetails } from '../liveSession.js'
 */
/**
 * @typedef {{
 *   options: LiveSessionOptions,
 *   connect: Mock<() => Promise<void>>,
 *   disconnect: Mock<() => void>,
 *   dispose: Mock<() => void>,
 *   sendAudioFrame: Mock<(base64Frame: string) => void>,
 * }} FakeSession
 * @typedef {{ ready: Promise<void>, stop: Mock<() => void>, getLevel: () => number }} FakeCapture
 * @typedef {{
 *   enqueue: Mock<(float32: Float32Array<ArrayBuffer>) => void>,
 *   interrupt: Mock<() => void>,
 *   close: Mock<() => void>,
 *   getLevel: () => number,
 * }} FakePlayer
 * @typedef {{ sessions: FakeSession[], captures: FakeCapture[], players: FakePlayer[], events: string[] }} Fakes
 */

// Every createLiveSession / startCapture / createPlayer call is recorded with
// an ordered event log, so tests can assert what happened before what.
const fakes = vi.hoisted(() => {
  /** @type {Fakes} */
  const recorded = { sessions: [], captures: [], players: [], events: [] };
  return recorded;
});

vi.mock('../liveSession.js', () => ({
  createLiveSession: vi.fn((/** @type {LiveSessionOptions} */ options) => {
    /** @type {FakeSession} */
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
    /** @type {FakeCapture} */
    const capture = {
      ready: Promise.resolve(),
      stop: vi.fn(() => {
        fakes.events.push(`capture#${n}.stop`);
      }),
      getLevel: () => 0,
    };
    fakes.captures.push(capture);
    return capture;
  }),
  createPlayer: vi.fn(() => {
    const n = fakes.players.length;
    /** @type {FakePlayer} */
    const player = {
      enqueue: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(() => {
        fakes.events.push(`player#${n}.close`);
      }),
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
      <AgentApp
        bridge={bridge}
        nonce="page-nonce"
        workletUrl="/agent-client/capture-worklet.js"
        portalContainer={document.body}
      />
    </StrictMode>,
  );
  return { bridge, ...utils };
}

// The card's own controls, by the spec's names (Screens): the failure toast
// renders outside the card, in its own region, and may repeat a label.
const TALK = 'Talk to the AI Presenter';
const card = () => screen.getByRole('complementary', { name: 'AI presenter' });
/** @param {string | RegExp} name */
const cardButton = (name) => {
  const button = within(card()).getByRole('button', { name });
  if (!(button instanceof HTMLButtonElement)) throw new Error(`${name} is not a <button>`);
  return button;
};
const statusLine = () => within(card()).getByRole('status');
// The volume orb: decorative (aria-hidden), so found by its class.
const orb = () => elementOf(card().querySelector('.volume-orb'), HTMLElement);

/** @param {string | RegExp} name */
async function click(name) {
  await act(async () => {
    fireEvent.click(cardButton(name));
  });
}

// Radix's toast viewport ("Notifications (F8)") and the toasts in it.
const toasts = () =>
  within(screen.getByRole('region', { name: 'Notifications (F8)' })).queryAllByRole('listitem');

/**
 * @param {SessionStatus} status
 * @param {StatusDetails} [details]
 */
function emitStatus(status, details) {
  const session = lastSession();
  act(() => defined(session.options.onStatusChange, 'onStatusChange')(status, details));
}

const lastSession = () => defined(fakes.sessions.at(-1), 'a session');

// The first session's transcript callbacks, which useLiveAgent always passes.
function transcriptHandlers() {
  const { onTranscript, onTurnEnd } = fakes.sessions[0].options;
  return {
    onTranscript: defined(onTranscript, 'onTranscript'),
    onTurnEnd: defined(onTurnEnd, 'onTurnEnd'),
  };
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
  it('starts idle with an enabled Talk to the AI Presenter button', () => {
    renderApp();
    expect(cardButton(TALK).disabled).toBe(false);
  });

  it('hands the page nonce from main.jsx to the live session', async () => {
    renderApp();
    await click(TALK);
    expect(fakes.sessions[0].options.nonce).toBe('page-nonce');
  });

  it('hands the worklet URL from main.jsx to the mic capture', async () => {
    renderApp();
    await click(TALK);
    expect(startCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ workletUrl: '/agent-client/capture-worklet.js' }),
    );
  });

  it('over plain http, says voice needs https and opens no session', async () => {
    vi.mocked(voiceSupportError).mockReturnValueOnce(
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
    vi.mocked(voiceSupportError).mockReturnValueOnce(
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
    expect(within(toasts()[0]).getByText(/Reload the page to reconnect/)).toBeTruthy();
    expect(statusLine().textContent).toMatch(/Connection lost/);

    await click('Retry');
    expect(session.connect).toHaveBeenCalledTimes(2);
  });

  it('reports each failure once to onFailure (the client log), and nothing else', async () => {
    const onFailure = vi.fn();
    render(
      <StrictMode>
        <AgentApp
          bridge={fakeBridge()}
          nonce="page-nonce"
          workletUrl="/agent-client/capture-worklet.js"
          portalContainer={document.body}
          onFailure={onFailure}
        />
      </StrictMode>,
    );
    await click(TALK);
    const exhausted = { attempt: 6, maxAttempts: 6, reason: 'Could not reconnect.' };

    emitStatus('open');
    emitStatus('reconnecting', { attempt: 1, maxAttempts: 6 });
    expect(onFailure).not.toHaveBeenCalled();
    emitStatus('failed', exhausted);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(exhausted);

    await click('Retry');
    emitStatus('connecting');
    emitStatus('failed', exhausted);
    expect(onFailure).toHaveBeenCalledTimes(2);
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
    expect(button.dataset.variant).toBe('secondary'); // outline, the stop action
    expect(statusLine().textContent).toBe('Reconnecting (attempt 2 of 6)…');
    // The orb pulses in CSS while reconnecting (VolumeOrb.jsx).
    expect(orb().dataset.reconnecting).toBe('true');
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

    expect(within(toasts()[0]).getByText(/Reload the page to reconnect/)).toBeTruthy();
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

    expect(within(toasts()[0]).getByText(/Contact the site owner/)).toBeTruthy();
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

    /** @type {[SessionStatus, StatusDetails | undefined, string][]} */
    const steps = [
      ['connecting', undefined, 'Cancel'],
      ['reconnecting', { attempt: 1, maxAttempts: 6 }, 'End'],
      [
        'failed',
        { attempt: 6, maxAttempts: 6, reason: 'Could not reconnect after 6 attempts.' },
        'Retry',
      ],
    ];
    for (const [status, details, label] of steps) {
      emitStatus(status, details);
      expect(document.activeElement).toBe(button);
      expect(button.textContent).toBe(label);
      expect(button.disabled).toBe(false);
    }
  });

  it('ends the session when the microphone is blocked, so the guidance to press Talk is true', async () => {
    const stop = vi.fn();
    // getUserMedia rejects after connect() has started, as in a real browser.
    vi.mocked(startCapture).mockImplementationOnce(({ onError }) => {
      const ready = Promise.resolve().then(() =>
        defined(
          onError,
          'onError',
        )(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })),
      );
      return { ready, stop, getLevel: () => 0 };
    });
    renderApp();
    await click(TALK);
    const session = lastSession();
    await act(async () => {});

    expect(session.disconnect).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    emitStatus('closed');
    expect(cardButton(TALK)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Microphone blocked — allow it in the address bar and press Talk to the AI Presenter.',
    );
  });

  // I7: whatever stops the mic from starting, the agent can't hear the user,
  // so the card never shows Live while deaf: the session ends, and the alert
  // says why in the error's own words.
  it.each([
    [
      'the worklet failing to load',
      Object.assign(new Error("Unable to load a worklet's module."), { name: 'WorkletLoadError' }),
      "Voice couldn't start. Reload the page, then press Talk to the AI Presenter.",
    ],
    [
      'the browser never starting audio',
      Object.assign(new Error('The browser did not start audio in time.'), {
        name: 'AudioResumeTimeoutError',
      }),
      "Voice couldn't start: the browser kept audio paused. Press Talk to the AI Presenter to try again.",
    ],
    [
      'no microphone',
      Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }),
      'No microphone found. Connect one, then press Talk to the AI Presenter.',
    ],
    [
      'the microphone busy',
      Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' }),
      'Microphone unavailable: Could not start audio source',
    ],
  ])('ends the session when capture fails with %s', async (_name, error, text) => {
    const stop = vi.fn();
    vi.mocked(startCapture).mockImplementationOnce(({ onError }) => {
      const ready = Promise.resolve().then(() => defined(onError, 'onError')(error));
      return { ready, stop, getLevel: () => 0 };
    });
    renderApp();
    await click(TALK);
    const session = lastSession();
    await act(async () => {});

    expect(session.disconnect).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    emitStatus('closed');
    expect(cardButton(TALK)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(text);
  });

  it('re-announces an identical microphone error after Talk: the alert is a new node', async () => {
    const blocked = () =>
      vi.mocked(startCapture).mockImplementationOnce(({ onError }) => ({
        ready: Promise.resolve().then(() =>
          defined(
            onError,
            'onError',
          )(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })),
        ),
        stop: vi.fn(),
        getLevel: () => 0,
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
    act(() => transcriptHandlers().onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(within(card()).getByRole('region', { name: 'Transcript' }).textContent).toBe(
      'Presenter: Hello!',
    );
  });

  it("coalesces the session's fragments into turns, spacing a turn the same speaker continues", async () => {
    renderApp();
    await click(TALK);
    const { onTranscript, onTurnEnd } = transcriptHandlers();
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

    act(() => transcriptHandlers().onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(screen.getByRole('region', { name: 'Transcript' }).textContent).toBe(
      'Presenter: Hello!',
    );
  });

  it('names the knowledge button with its visible file count, hiding the icon from assistive tech', () => {
    renderApp();
    // Named by its content, so the visible "0" is part of the name (WCAG 2.5.3).
    const button = screen.getByRole('button', { name: 'Knowledge files: 0' });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.title).toBe('Knowledge files');
    const icon = button.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('stroke')).toBe('currentColor');
  });

  it('shows End while open, and End tears the audio down', async () => {
    renderApp();
    await click(TALK);
    emitStatus('open');
    expect(statusLine().textContent).toBe('Live');
    expect(cardButton('End').dataset.variant).toBe('secondary');
    expect(orb().hasAttribute('data-reconnecting')).toBe(false);
    await click('End');
    expect(fakes.sessions[0].disconnect).toHaveBeenCalled();
    expect(fakes.captures[0].stop).toHaveBeenCalled();
    expect(fakes.players[0].close).toHaveBeenCalled();
  });
});

// The failure toast (spec Screens, R20): a Radix toast, once per failure, with
// the reason and Dismiss; the card's button is the one action. The toast is
// the one live announcement of the reason; the card shows the reason as plain
// text once the toast has closed, so one reason is on screen and a screen
// reader hears it once.
describe('the failure toast', () => {
  const REASON = 'Could not reconnect after 6 attempts.';
  const EXHAUSTED = { attempt: 6, maxAttempts: 6, reason: REASON };

  // Every live region whose text includes `text`: role alert or status, or an
  // aria-live other than off.
  /** @param {string} text */
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

  it('shows the reason and Dismiss, no action of its own, and the card hides its reason while it is open', async () => {
    await failOnce();
    const [toast] = toasts();
    expect(within(toast).getByText(REASON)).toBeTruthy();
    expect(
      within(toast)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['×Dismiss']);
    // Its space is kept, so Retry doesn't move when the toast closes, but it
    // is neither seen nor read.
    const held = within(card()).getByText(REASON);
    expect(held.getAttribute('aria-hidden')).toBe('true');
    expect(held.dataset.held).toBe('true');
    expect(within(card()).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(card()).queryByRole('alert')).toBeNull();
  });

  it('shows the reason in the card, as plain text, once the toast is dismissed', async () => {
    await failOnce();
    await act(async () => {
      fireEvent.click(within(toasts()[0]).getByRole('button', { name: 'Dismiss' }));
    });
    expect(toasts()).toHaveLength(0);
    const line = within(card()).getByText(REASON);
    expect(line.hasAttribute('aria-hidden')).toBe(false);
    expect(line.hasAttribute('data-held')).toBe(false);
    expect(line.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull();
  });

  it('shows the reason in the card once the toast times out', async () => {
    vi.useFakeTimers();
    try {
      await failOnce();
      expect(within(card()).getByText(REASON).getAttribute('aria-hidden')).toBe('true');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(toasts()).toHaveLength(0);
      expect(within(card()).getByText(REASON).hasAttribute('aria-hidden')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the failed headline for its own style', async () => {
    await failOnce();
    expect(statusLine().dataset.status).toBe('failed');
  });

  it('announces the reason exactly once, through the toast, and not again when the card shows it', async () => {
    await failOnce();
    await waitFor(() => expect(liveRegionsWith(REASON)).toHaveLength(1));
    const [announcer] = liveRegionsWith(REASON);
    expect(announcer.getAttribute('aria-live')).toBe('assertive');
    // Where to act is announced with it: the toast has no button of its own.
    expect(announcer.textContent).toContain('Use the Retry button on the presenter card.');
    expect(card().contains(announcer)).toBe(false);

    await act(async () => {
      fireEvent.keyDown(toasts()[0], { key: 'Escape' });
    });
    expect(within(card()).getByText(REASON)).toBeTruthy();
    expect(liveRegionsWith(REASON).filter((region) => card().contains(region))).toEqual([]);
  });

  it('does not come back once closed, whatever re-renders the card', async () => {
    await failOnce();
    await act(async () => {
      fireEvent.keyDown(toasts()[0], { key: 'Escape' });
    });
    expect(toasts()).toHaveLength(0);

    act(() => transcriptHandlers().onTranscript({ role: 'agent', text: 'Hello!' }));
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

  it("names the card's button, Reload page for a rejected token, in the toast's hidden line", async () => {
    renderApp();
    await click(TALK);
    emitStatus('failed', { ...EXHAUSTED, reason: 'Reload the page to reconnect.', fatal: 'token' });
    const [toast] = toasts();
    expect(
      within(toast).getByText('Use the Reload page button on the presenter card.'),
    ).toBeTruthy();
    expect(within(toast).queryByRole('button', { name: 'Reload page' })).toBeNull();
    expect(within(card()).getByRole('button', { name: 'Reload page' })).toBeTruthy();
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
  // toast, Dismiss, then back to the card's button, either way.
  it('walks Tab from F8 through the toast and back to the card, and Shift+Tab back again', async () => {
    const button = await failOnce();
    const viewport = within(screen.getByRole('region', { name: 'Notifications (F8)' })).getByRole(
      'list',
    );
    const [toast] = toasts();
    const dismiss = within(toast).getByRole('button', { name: 'Dismiss' });

    fireEvent.keyDown(document, { key: 'F8', code: 'F8' });
    expect(document.activeElement).toBe(viewport);
    for (const next of [toast, dismiss, button]) {
      fireEvent.keyDown(defined(document.activeElement, 'the focus'), { key: 'Tab' });
      expect(document.activeElement).toBe(next);
    }

    dismiss.focus();
    for (const previous of [toast, button]) {
      fireEvent.keyDown(defined(document.activeElement, 'the focus'), {
        key: 'Tab',
        shiftKey: true,
      });
      expect(document.activeElement).toBe(previous);
    }
    expect(toasts()).toHaveLength(1);
  });
});
