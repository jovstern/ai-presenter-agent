import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { test, expect } from './fixtures.js';
import { TOKEN_OK, card, fakeGeminiLive, stubToken } from './fakeLive.js';

// The Gemini SDK is a chunk of its own, loaded on Talk
// (docs/adr/0005-load-the-gemini-sdk-on-talk.md, agent-client/src/liveSdk.js):
// the page loads without it, reaching for Talk starts it, and a chunk that
// doesn't arrive is a clear failure that Retry recovers from.

const DIST = new URL('../agent-client/dist/', import.meta.url);
const SDK_CHUNK = /\/agent-client\/web-[\w-]+\.js$/;
// The spec's Budgets: the page-load bundle, and the SDK chunk on Talk (kB = 1000 B, as Vite reports).
const PAGE_LOAD_BUDGET = 180_000;
const SDK_CHUNK_BUDGET = 80_000;

/** @param {string} name */
const gzipSize = (name) => gzipSync(readFileSync(new URL(name, DIST))).length;

// The webServer built dist/ just before this run (playwright.config.js).
test('the build keeps the SDK out of the page-load bundle, within the budgets', () => {
  const chunks = readdirSync(DIST).filter((name) => /^web-[\w-]+\.js$/.test(name));
  expect(chunks).toHaveLength(1);

  const entry = readFileSync(new URL('agent-client.js', DIST), 'utf8');
  // The Live endpoint is in the SDK's code only.
  expect(entry).not.toContain('BidiGenerateContent');
  expect(readFileSync(new URL(chunks[0], DIST), 'utf8')).toContain('BidiGenerateContent');
  expect(entry).toContain(`import(\`./${chunks[0]}\`)`);

  expect(gzipSize('agent-client.js')).toBeLessThanOrEqual(PAGE_LOAD_BUDGET);
  expect(gzipSize(chunks[0])).toBeLessThanOrEqual(SDK_CHUNK_BUDGET);
});

test('the page loads without the SDK; pointing at Talk fetches it once, and Talk connects', async ({
  page,
}) => {
  await stubToken(page, TOKEN_OK);
  await fakeGeminiLive(page);
  /** @type {string[]} */
  const sdkRequests = [];
  page.on('request', (request) => {
    if (SDK_CHUNK.test(new URL(request.url()).pathname)) sdkRequests.push(request.url());
  });
  const { status, button } = card(page);

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(status).toHaveText('Not connected');
  expect(sdkRequests).toEqual([]);

  await button('Talk to the AI Presenter').hover();
  await expect.poll(() => sdkRequests.length).toBe(1);

  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  await button('End').click();
  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  expect(sdkRequests).toHaveLength(1);
});

test.describe('when the SDK chunk does not load', () => {
  // The aborted request, as Chromium logs it.
  test.use({ allowedConsoleErrors: [/net::ERR_FAILED/] });

  test("Talk ends in Can't connect with Retry, which loads the chunk and connects", async ({
    page,
  }) => {
    await stubToken(page, TOKEN_OK);
    const live = await fakeGeminiLive(page);
    let aborts = 1;
    let sdkLoads = 0;
    await page.route(SDK_CHUNK, async (route) => {
      if (aborts > 0) {
        aborts -= 1;
        await route.abort('failed');
        return;
      }
      sdkLoads += 1;
      await route.continue();
    });
    const { panel, status, button, toasts } = card(page);
    const reason = "The voice client couldn't load. Check your connection, then retry.";

    await page.goto('/');
    // A click with no pointer or focus before it: the press itself loads the chunk.
    await button('Talk to the AI Presenter').dispatchEvent('click');

    await expect(status).toHaveText("Can't connect");
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toContainText(reason);
    await expect(button('Retry')).toBeVisible();
    // The backoff is for the voice socket: nothing retries by itself.
    await page.waitForTimeout(1500);
    expect(live.sockets).toHaveLength(0);
    expect(sdkLoads).toBe(0);

    await toasts.getByRole('button', { name: 'Dismiss' }).click();
    await expect(panel.getByText(reason)).toBeVisible();
    await button('Retry').click();
    await expect(status).toHaveText('Live');
    expect(sdkLoads).toBe(1);
    expect(live.sockets).toHaveLength(1);
  });
});
