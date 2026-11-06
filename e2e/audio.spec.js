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
  const panel = page
    .locator('#ai-presenter-agent-host')
    .getByRole('complementary', { name: 'AI presenter' });
  await panel.getByRole('button', { name: 'Talk to the presenter', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Live');

  // Frames queued while connecting are flushed in a burst at setupComplete,
  // so the rate is measured from a frame that arrives after that. The check
  // is the audio the frames carry (80 ms each) against the wall-clock window
  // they arrived in, over a fixed 4 s window: a loaded runner that stalls the
  // page for a moment only moves frames past the window's end, which costs
  // a few percent, not the 2-3x a wrong resampling ratio would.
  await expect.poll(() => audioFrames.length).toBeGreaterThan(0);
  const from = audioFrames.length;
  await expect.poll(() => audioFrames.length).toBeGreaterThan(from);
  const start = audioFrames[from].at;
  const WINDOW_MS = 4000;
  await page.waitForTimeout(WINDOW_MS + 500);
  const inWindow = audioFrames.filter(({ at }) => at >= start && at < start + WINDOW_MS);
  const audioSeconds = inWindow.length / FRAMES_PER_SECOND;
  const ratio = audioSeconds / (WINDOW_MS / 1000);
  expect(ratio).toBeGreaterThan(0.75);
  expect(ratio).toBeLessThan(1.25);

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

  // End stops the stream: no frame after the hang-up.
  await panel.getByRole('button', { name: 'End', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Not connected');
  const afterHangUp = audioFrames.length;
  await page.waitForTimeout(500);
  expect(audioFrames).toHaveLength(afterHangUp);
});
