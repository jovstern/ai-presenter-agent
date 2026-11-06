import { vi } from 'vitest';

// Fakes for the volume orb's tests (VolumeOrb.test.jsx, renderIsolation.test.jsx):
// requestAnimationFrame driven one tick at a time, and a matchMedia whose
// prefers-reduced-motion answer a test can flip. Call from beforeEach; the
// tests' afterEach undoes them with vi.unstubAllGlobals().

/** A requestAnimationFrame that runs only when the test calls tick(). */
export function fakeAnimationFrames() {
  /** @type {Map<number, FrameRequestCallback>} */
  const pending = new Map();
  let nextId = 1;
  const request = vi.fn((/** @type {FrameRequestCallback} */ callback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn((/** @type {number} */ id) => pending.delete(id));
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    request,
    cancel,
    get pendingCount() {
      return pending.size;
    },
    /** Runs the callbacks due this frame, as the browser would. */
    tick() {
      const due = [...pending.values()];
      pending.clear();
      due.forEach((callback) => callback(performance.now()));
    },
  };
}

/** A matchMedia for '(prefers-reduced-motion: reduce)' only, flipped by set(). */
export function fakeReducedMotion(initially = false) {
  let matches = initially;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((/** @type {string} */ query) => ({
      get matches() {
        return query === '(prefers-reduced-motion: reduce)' && matches;
      },
      media: query,
      addEventListener: (/** @type {string} */ type, /** @type {() => void} */ fn) =>
        listeners.add(fn),
      removeEventListener: (/** @type {string} */ type, /** @type {() => void} */ fn) =>
        listeners.delete(fn),
    })),
  );
  return {
    get listenerCount() {
      return listeners.size;
    },
    /** @param {boolean} value */
    set(value) {
      matches = value;
      listeners.forEach((fn) => fn());
    },
  };
}
