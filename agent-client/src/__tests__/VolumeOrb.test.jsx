import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { VolumeOrb } from '../VolumeOrb.jsx';
import { fakeAnimationFrames, fakeReducedMotion } from './rafHarness.js';
import { elementOf } from './defined.js';

// The orb's animation loop: when it runs, what it writes, and that it stops.
// Render isolation (no React render per frame) is renderIsolation.test.jsx.

/** @type {ReturnType<typeof fakeAnimationFrames>} */
let frames;
/** @type {ReturnType<typeof fakeReducedMotion>} */
let motion;
/** @type {{ output: number, mic: number }} */
let levels;

/** @param {{ active?: boolean }} [props] */
function renderOrb({ active = true } = {}) {
  const utils = render(
    <VolumeOrb active={active} outputLevel={() => levels.output} micLevel={() => levels.mic} />,
  );
  const orb = elementOf(utils.container.firstElementChild, HTMLElement);
  return { orb, ...utils };
}

/** @param {HTMLElement} orb */
const cssLevel = (orb) => orb.style.getPropertyValue('--level');
/** @param {HTMLElement} orb */
const cssMicLevel = (orb) => orb.style.getPropertyValue('--mic-level');

beforeEach(() => {
  frames = fakeAnimationFrames();
  motion = fakeReducedMotion(false);
  levels = { output: 0, mic: 0 };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VolumeOrb', () => {
  it('is decoration: hidden from assistive technology', () => {
    const { orb } = renderOrb();
    expect(orb.getAttribute('aria-hidden')).toBe('true');
  });

  it('while active, writes both levels to CSS variables every frame', () => {
    const { orb } = renderOrb();
    levels = { output: 0.5, mic: 0.25 };
    frames.tick();
    expect(Number(cssLevel(orb))).toBeCloseTo(0.5, 3);
    expect(Number(cssMicLevel(orb))).toBeCloseTo(0.25, 3);

    levels = { output: 0.75, mic: 0.5 };
    frames.tick();
    expect(Number(cssLevel(orb))).toBeCloseTo(0.75, 3);
    expect(Number(cssMicLevel(orb))).toBeCloseTo(0.5, 3);
    expect(frames.pendingCount).toBe(1); // the next frame is booked
  });

  // A write restyles the rings, so a frame whose rounded levels match the
  // last ones written (silence, a steady tone) writes nothing (m07.md).
  it('writes a level only when its 2-decimal value changes', () => {
    const { orb } = renderOrb();
    const setProperty = vi.spyOn(orb.style, 'setProperty');
    levels = { output: 0.5, mic: 0.25 };
    frames.tick();
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(cssLevel(orb)).toBe('0.50');

    levels = { output: 0.501, mic: 0.252 }; // the same at 2 decimals
    frames.tick();
    expect(setProperty).toHaveBeenCalledTimes(2);

    levels = { output: 0.6, mic: 0.252 };
    frames.tick();
    expect(setProperty).toHaveBeenCalledTimes(3);
    expect(setProperty).toHaveBeenLastCalledWith('--level', '0.60');
  });

  it('rises at once but falls off smoothly, so speech does not flicker', () => {
    const { orb } = renderOrb();
    levels = { output: 0.8, mic: 0 };
    frames.tick();
    levels = { output: 0, mic: 0 };
    frames.tick();
    const afterDrop = Number(cssLevel(orb));
    expect(afterDrop).toBeGreaterThan(0);
    expect(afterDrop).toBeLessThan(0.8);
    for (let i = 0; i < 120; i++) frames.tick();
    expect(Number(cssLevel(orb))).toBe(0);
  });

  it('runs no loop while not active, and the orb rests', () => {
    const { orb } = renderOrb({ active: false });
    expect(frames.request).not.toHaveBeenCalled();
    expect(cssLevel(orb)).toBe('');
    expect(orb.dataset.active).toBe('false');
  });

  it('stops the loop and returns to rest when it stops being active', () => {
    const { orb, rerender } = renderOrb();
    levels = { output: 0.5, mic: 0.5 };
    frames.tick();

    rerender(<VolumeOrb active={false} outputLevel={() => 1} micLevel={() => 1} />);
    expect(frames.pendingCount).toBe(0);
    expect(cssLevel(orb)).toBe('');
    expect(cssMicLevel(orb)).toBe('');
  });

  it('stops the loop on unmount: no frame stays booked and no source is read again', () => {
    const outputLevel = vi.fn(() => 0.5);
    const { unmount } = render(<VolumeOrb active outputLevel={outputLevel} micLevel={() => 0} />);
    frames.tick();
    expect(outputLevel).toHaveBeenCalledTimes(1);

    unmount();
    expect(frames.cancel).toHaveBeenCalled();
    expect(frames.pendingCount).toBe(0);
    frames.tick();
    expect(outputLevel).toHaveBeenCalledTimes(1);
    expect(motion.listenerCount).toBe(0); // the media query is unsubscribed too
  });

  it('under reduced motion runs no loop at all, even while active', () => {
    motion.set(true);
    const { orb } = renderOrb();
    expect(frames.request).not.toHaveBeenCalled();
    expect(cssLevel(orb)).toBe('');
    expect(orb.dataset.active).toBe('true');
  });

  it('follows a change of the reduced-motion preference while live', () => {
    const { orb } = renderOrb();
    levels = { output: 0.5, mic: 0.5 };
    frames.tick();

    act(() => motion.set(true));
    expect(frames.pendingCount).toBe(0);
    expect(cssLevel(orb)).toBe(''); // the static level from styles.css

    act(() => motion.set(false));
    expect(frames.pendingCount).toBe(1);
    frames.tick();
    expect(Number(cssLevel(orb))).toBeCloseTo(0.5, 3);
  });

  // The pulse itself is CSS (styles.css); the orb only says it reconnects.
  it('marks reconnecting for the CSS pulse, runs no loop then, and drops the mark after', () => {
    const { container, rerender } = render(
      <VolumeOrb active={false} reconnecting outputLevel={() => 1} micLevel={() => 1} />,
    );
    const orb = elementOf(container.firstElementChild, HTMLElement);
    expect(orb.dataset.reconnecting).toBe('true');
    expect(frames.request).not.toHaveBeenCalled();

    rerender(<VolumeOrb active outputLevel={() => 1} micLevel={() => 1} />);
    expect(orb.hasAttribute('data-reconnecting')).toBe(false);
    expect(frames.pendingCount).toBe(1);
  });

  it('treats a browser without matchMedia as having no motion preference', () => {
    vi.stubGlobal('matchMedia', undefined);
    renderOrb();
    expect(frames.request).toHaveBeenCalledTimes(1);
  });
});
