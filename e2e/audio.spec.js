import { test, expect } from './fixtures.js';

// Mic capture in the real browser, with no key: Chromium's fake mic
// (playwright.config.js) through the real AudioWorklet
// (agent-client/public/capture-worklet.js) and the real SDK socket, which
// Playwright answers instead of Google (as in loop.spec.js). The fixture fails
// the test on any CSP violation, so a worklet the CSP blocked (it loads under
// script-src 'self') fails here as well as sending no frames.

const LIVE_SOCKET = /^wss:\/\/generativelanguage\.googleapis\.com\//;
const FRAME_BYTES = 1280 * 2; // 80 ms of 16 kHz Int16
const FRAMES_PER_SECOND = 16000 / 1280; // 12.5

test('the capture worklet loads under the CSP and streams 16 kHz frames in real time', async ({
  page,
}) => {
  await page.route('/api/live-token?*', (route) =>
    route.fulfill({ status: 200, json: { token: 'e2e-token' } }),
  );
  /** @type {{ at: number, audio: { data: string, mimeType: string } }[]} */
  const audioFrames = [];
  await page.routeWebSocket(LIVE_SOCKET, (ws) => {
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (frame.realtimeInput?.audio) {
        audioFrames.push({ at: performance.now(), audio: frame.realtimeInput.audio });
      }
    });
  });
  await page.goto('/');
  const host = page.locator('#ai-presenter-agent-host');
  await host.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(host.getByRole('status')).toHaveText('Live');

  // Frames queued while connecting are flushed in a burst at setupComplete,
  // so the rate is measured from a frame that arrives after that.
  await expect.poll(() => audioFrames.length).toBeGreaterThan(0);
  const from = audioFrames.length;
  await page.waitForTimeout(2000);
  const measured = audioFrames.slice(from);
  const seconds = (measured.at(-1).at - measured[0].at) / 1000;
  const rate = (measured.length - 1) / seconds;
  expect(rate).toBeGreaterThan(FRAMES_PER_SECOND * 0.75);
  expect(rate).toBeLessThan(FRAMES_PER_SECOND * 1.25);

  for (const { audio } of audioFrames) {
    expect(audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(audio.data, 'base64')).toHaveLength(FRAME_BYTES);
  }
  // The fake mic's beep, not silence: the samples really come from the track.
  const loudest = Math.max(
    ...audioFrames.map(({ audio }) => {
      const bytes = Buffer.from(audio.data, 'base64');
      let peak = 0;
      for (let i = 0; i < bytes.length; i += 2)
        peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
      return peak;
    }),
  );
  expect(loudest).toBeGreaterThan(1000);

  // Served where main.jsx resolves it, next to the bundle, as JavaScript.
  // (Chromium's worklet fetch isn't a Playwright network event, so this is
  // checked with a request of its own; the frames above prove the page's
  // load.)
  const worklet = await page.request.get('/agent-client/capture-worklet.js');
  expect(worklet.status()).toBe(200);
  expect(worklet.headers()['content-type']).toMatch(/^text\/javascript/);

  // Disconnect stops the stream: no frame after the hang-up.
  await host.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(host.getByRole('status')).toHaveText('Not connected');
  const afterHangUp = audioFrames.length;
  await page.waitForTimeout(500);
  expect(audioFrames).toHaveLength(afterHangUp);
});
