import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { AgentApp } from '../AgentApp.jsx';
import { fakeAnimationFrames, fakeReducedMotion } from './rafHarness.js';

// Render isolation (spec goals #8 and #9, docs/code-review-notes.md L2, L8):
// the volume orb animates at the display's frame rate without React rendering
// anything per frame. The levels travel source → rAF loop → a CSS variable on
// the orb's node, never through React state.
//
// Counting renders alone would pass trivially if the orb never animated, so
// the test also proves the frames did reach the page: --level changes on every
// one of the 50 ticks. And it proves the counter can see a render: a
// transcript line does re-render the card, without disturbing the orb's loop.

const commits = vi.hoisted(() => ({ card: 0, orb: 0 }));
const fakes = vi.hoisted(() => ({ sessions: [], levels: { output: 0, mic: 0 } }));

// The real VolumeOrb, inside a Profiler of its own: a commit there is a
// render of the orb.
vi.mock('../VolumeOrb.jsx', async (importOriginal) => {
  const actual = /** @type {typeof import('../VolumeOrb.jsx')} */ (await importOriginal());
  return {
    /** @param {import('react').ComponentProps<typeof actual.VolumeOrb>} props */
    VolumeOrb: (props) => (
      <Profiler id="orb" onRender={() => commits.orb++}>
        <actual.VolumeOrb {...props} />
      </Profiler>
    ),
  };
});

vi.mock('../liveSession.js', () => ({
  createLiveSession: vi.fn((options) => {
    const session = {
      options,
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      dispose: vi.fn(),
      sendAudioFrame: vi.fn(),
    };
    fakes.sessions.push(session);
    return session;
  }),
}));

// The injected level sources: what the player and the mic report this frame.
vi.mock('../audioIO.js', () => ({
  voiceSupportError: vi.fn(() => null),
  startCapture: vi.fn(() => ({
    ready: Promise.resolve(),
    stop: vi.fn(),
    getLevel: () => fakes.levels.mic,
  })),
  createPlayer: vi.fn(() => ({
    enqueue: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    getLevel: () => fakes.levels.output,
  })),
}));

const bridge = {
  dispatchAction: vi.fn(async () => ({ success: true })),
  requestSnapshot: vi.fn(),
  onSnapshot: vi.fn(() => () => {}),
  onNavigated: vi.fn(() => () => {}),
  close: vi.fn(),
};

let frames;

beforeEach(() => {
  commits.card = 0;
  commits.orb = 0;
  fakes.sessions.length = 0;
  fakes.levels = { output: 0, mic: 0 };
  frames = fakeAnimationFrames();
  fakeReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('render isolation', () => {
  it('50 animation frames render nothing, yet move --level 50 times; a transcript line re-renders the card, not the loop', async () => {
    // No StrictMode: its double render would double every count.
    const { container } = render(
      <Profiler id="card" onRender={() => commits.card++}>
        <AgentApp bridge={bridge} nonce="page-nonce" workletUrl="/w.js" />
      </Profiler>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    act(() => fakes.sessions[0].options.onStatusChange('open'));
    expect(screen.getByRole('status').textContent).toBe('Live');

    const orb = /** @type {HTMLElement} */ (container.querySelector('[data-active="true"]'));
    expect(orb).not.toBeNull();
    const cardBefore = commits.card;
    const orbBefore = commits.orb;
    expect(orbBefore).toBeGreaterThan(0); // the probe does count the orb

    let levelChanges = 0;
    let micChanges = 0;
    let lastLevel = orb.style.getPropertyValue('--level');
    let lastMic = orb.style.getPropertyValue('--mic-level');
    for (let i = 0; i < 50; i++) {
      // A rising level, so no two frames show the same value.
      fakes.levels = { output: 0.1 + i * 0.01, mic: 0.6 - i * 0.01 };
      // Inside act(), so any state update a frame made would be rendered and
      // committed before the counts are read, not left pending.
      act(() => frames.tick());
      const level = orb.style.getPropertyValue('--level');
      const mic = orb.style.getPropertyValue('--mic-level');
      if (level !== lastLevel) levelChanges++;
      if (mic !== lastMic) micChanges++;
      lastLevel = level;
      lastMic = mic;
    }

    // The orb and every sibling: rendered once (to go live), not per frame.
    expect(commits.card).toBe(cardBefore);
    expect(commits.orb).toBe(orbBefore);
    // ...while the frames really did reach the page.
    expect(levelChanges).toBe(50);
    expect(micChanges).toBe(50);
    expect(Number(lastLevel)).toBeCloseTo(0.59, 3);

    // A transcript line is React state: the card does re-render, so the
    // counter above could have seen a render. The orb's loop carries on
    // through it: no frame cancelled, the level not reset.
    const cancelsBefore = frames.cancel.mock.calls.length;
    act(() => fakes.sessions[0].options.onTranscript({ role: 'agent', text: 'Hello!' }));
    expect(screen.getByText('Hello!')).toBeTruthy();
    expect(commits.card).toBeGreaterThan(cardBefore);
    expect(frames.cancel.mock.calls.length).toBe(cancelsBefore);
    expect(frames.pendingCount).toBe(1);
    expect(orb.style.getPropertyValue('--level')).toBe(lastLevel);
    fakes.levels = { output: 0.9, mic: 0.9 };
    act(() => frames.tick());
    expect(Number(orb.style.getPropertyValue('--level'))).toBeCloseTo(0.9, 3);
  });
});
