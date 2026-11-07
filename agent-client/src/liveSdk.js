// The Gemini SDK, loaded on demand (docs/adr/0005-load-the-gemini-sdk-on-talk.md).
// `@google/genai` is ~75 kB gzip, about 40 % of the widget, and only a Live
// session uses it, so it is a chunk of its own that the page fetches when the
// viewer reaches for Talk (preloadLiveSdk) or presses it (liveSession.js's
// openSession, in parallel with the token request) — never on page load.
// Nothing else may import it as a value, or it is back in the page-load chunk
// (e2e/bundle.spec.js checks the build).

/** @typedef {typeof import('@google/genai/web')} LiveSdk */

/** The SDK chunk didn't load: the network, or a page older than the deploy. */
export class SdkLoadError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super("The voice client couldn't load.", { cause });
    this.name = 'SdkLoadError';
  }
}

/**
 * A loader that imports the SDK once and shares the result. A failed import
 * is forgotten, so the next call (a Retry) imports again rather than
 * replaying the failure.
 * @param {() => Promise<LiveSdk>} importSdk
 * @returns {() => Promise<LiveSdk>}
 */
export function createSdkLoader(importSdk) {
  /** @type {Promise<LiveSdk> | null} */
  let pending = null;
  return () => {
    pending ??= importSdk().catch((/** @type {unknown} */ error) => {
      pending = null;
      throw new SdkLoadError(error);
    });
    return pending;
  };
}

// Explicit /web subpath, not the bare package: the bare entry's "browser"
// condition wasn't picked up by this build and pulled in the Node build
// instead, which references `process` and crashes in the browser.
export const loadLiveSdk = createSdkLoader(() => import('@google/genai/web'));

/**
 * Starts the fetch without waiting for it: called when the viewer points at
 * or focuses Talk, so the chunk is usually in by the press. A failure here is
 * left for the press to report (the loader forgets it, and the press retries).
 */
export function preloadLiveSdk() {
  loadLiveSdk().catch(() => {});
}
