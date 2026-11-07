import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SdkLoadError, createSdkLoader } from '../liveSdk.js';

/** @import { LiveSdk } from '../liveSdk.js' */

const SRC = path.resolve(import.meta.dirname, '..');
/** @param {string} name */
const source = (name) => readFileSync(path.join(SRC, name), 'utf8');

describe('createSdkLoader', () => {
  it('imports the SDK once and shares it between callers', async () => {
    // The loader only hands the module on, never reads it, so a stand-in with
    // one export is enough; typing it as the whole SDK module is the cast.
    const sdk = /** @type {LiveSdk} */ (/** @type {unknown} */ ({ GoogleGenAI: class {} }));
    const importSdk = vi.fn(async () => sdk);
    const load = createSdkLoader(importSdk);

    expect(importSdk).not.toHaveBeenCalled(); // nothing is fetched until asked
    const [first, second] = await Promise.all([load(), load()]);
    expect(await load()).toBe(sdk);

    expect(first).toBe(sdk);
    expect(second).toBe(sdk);
    expect(importSdk).toHaveBeenCalledTimes(1);
  });

  it('turns a failed import into an SdkLoadError, and imports again on the next call', async () => {
    const sdk = { GoogleGenAI: class {} };
    const chunkError = new TypeError('Failed to fetch dynamically imported module');
    const importSdk = vi.fn().mockRejectedValueOnce(chunkError).mockResolvedValueOnce(sdk);
    const load = createSdkLoader(importSdk);

    const failure = await load().catch((/** @type {unknown} */ error) => error);
    expect(failure).toBeInstanceOf(SdkLoadError);
    expect(failure).toMatchObject({
      message: "The voice client couldn't load.",
      cause: chunkError,
    });

    expect(await load()).toBe(sdk);
    expect(importSdk).toHaveBeenCalledTimes(2);
  });
});

// The SDK stays out of the page-load chunk only while no module imports it as
// a value; liveSdk.js's import() is the one way in (e2e/sdk.spec.js checks
// the build output itself). JSDoc `@import`s are types only and don't count.
describe('the page-load module graph', () => {
  it('has no static import of @google/genai outside type comments', () => {
    const files = readdirSync(SRC).filter((name) => /\.jsx?$/.test(name));
    expect(files).toContain('liveSession.js');

    const offenders = files.filter((name) => {
      return /^\s*(import|export)\b[^;]*?\bfrom\s*['"]@google\/genai/m.test(source(name));
    });
    expect(offenders).toEqual([]);
  });

  it('reaches the SDK through one dynamic import, in liveSdk.js', () => {
    const files = readdirSync(SRC).filter((name) => /\.jsx?$/.test(name));
    const importers = files.filter((name) => /\bimport\(\s*['"]@google\/genai/.test(source(name)));
    expect(importers).toEqual(['liveSdk.js']);
  });
});
