import { defineConfig, devices } from '@playwright/test';

// The deterministic e2e (R11): no Gemini key, no network beyond localhost. The
// token endpoint is stubbed per test with page.route and the Live socket with
// page.routeWebSocket (e2e/loop.spec.js), so the dummy key below never reaches
// Google.

// Fixed and uncommon, so it never collides with `npm run dev` on 3000.
// reuseExistingServer is off: a server already on this port (one started with
// the real key, say) fails the run instead of being silently reused.
const PORT = 3971;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0, // a flaky test is a bug to fix, not to retry
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A fake mic that grants itself: the loop spec presses Connect, which
        // calls getUserMedia (audioIO.js). It streams a tone; nobody listens.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
  webServer: {
    // Builds the agent-client first so the bundle under test is the current
    // source, then runs the server directly (not `npm start`) from the root.
    command: 'npm --prefix agent-client run build && node server/index.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      // index.js imports dotenv/config, which reads the .env in the working
      // directory (server/.env, the real key, under `npm start`). Pointing it
      // at an empty file means the e2e server only ever sees the env given here,
      // wherever it runs from; the dummy key also overrides an exported one.
      DOTENV_CONFIG_PATH: '/dev/null',
      DOTENV_CONFIG_QUIET: 'true',
      GEMINI_API_KEY: 'e2e-dummy',
      LOG_LEVEL: 'warn',
    },
  },
});
