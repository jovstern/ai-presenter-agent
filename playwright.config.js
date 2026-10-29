import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Two suites, one config:
// - The deterministic e2e (R11, `npm run e2e`): no Gemini key, no network
//   beyond localhost. The token endpoint is stubbed per test with page.route
//   and the Live socket with page.routeWebSocket (e2e/loop.spec.js), so the
//   dummy key below never reaches Google.
// - The opt-in live e2e (R12, `npm run e2e:live`, GEMINI_LIVE_E2E=1): the real
//   server key and the real Gemini Live API, a spoken prompt per project
//   (e2e/live.spec.js, docs/metrics/README.md). Only this mode defines the live
//   projects, so `npm run e2e` never sees them.
const LIVE = process.env.GEMINI_LIVE_E2E === '1';

// Fixed and uncommon, so neither collides with `npm run dev` on 3000 or with
// each other. reuseExistingServer is off: a server already on the port (one
// started with a different key, say) fails the run instead of being reused.
const PORT = LIVE ? 3972 : 3971;
const BASE_URL = `http://localhost:${PORT}`;

// The deterministic suite's fake mic grants itself and streams a tone; the
// loop spec presses Connect, which calls getUserMedia (audioIO.js).
const FAKE_MIC = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

const PROMPTS = fileURLToPath(new URL('./e2e/fixtures/prompts/', import.meta.url));

// One project per spoken prompt, because the fake-capture file is a browser
// launch flag. %noloop plays it once: a looping prompt would repeat the task
// and trip the loop guard. Each project runs only its own scenario.
/**
 * @param {string} scenario The live.spec.js test title prefix and the WAV name.
 * @param {string} wav
 */
function liveProject(scenario, wav) {
  return {
    name: `live-${scenario}`,
    testMatch: 'live.spec.js',
    grep: new RegExp(`${scenario}: `),
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        args: [...FAKE_MIC, `--use-file-for-fake-audio-capture=${PROMPTS}${wav}%noloop`],
      },
    },
  };
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: !LIVE,
  // One live session at a time: the scenarios share one API key and one
  // per-IP token rate limit, and the numbers are cleaner unloaded.
  workers: LIVE ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  // A flaky test is a bug to fix, not to retry. The live suite isn't retried
  // either: its pass rate is one of the metrics it reports.
  retries: 0,
  reporter: LIVE
    ? [['list'], ['./e2e/live-reporter.js']]
    : process.env.CI
      ? [['list'], ['html', { open: 'never' }]]
      : 'list',
  use: {
    baseURL: BASE_URL,
    // No trace in live mode: it would record the minted token (the token
    // response and the Live socket URL).
    trace: LIVE ? 'off' : 'retain-on-failure',
  },
  projects: LIVE
    ? [
        liveProject('greeting', 'greeting.wav'),
        liveProject('task', 'task.wav'),
        liveProject('reconnect', 'followup.wav'),
      ]
    : [
        {
          name: 'chromium',
          testIgnore: 'live.spec.js',
          use: { ...devices['Desktop Chrome'], launchOptions: { args: FAKE_MIC } },
        },
      ],
  webServer: {
    // Builds the agent-client first so the bundle under test is the current
    // source, then runs the server directly (not `npm start`).
    command: LIVE
      ? 'npm --prefix ../agent-client run build && node index.js'
      : 'npm --prefix agent-client run build && node server/index.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    // index.js imports dotenv/config, which reads the .env in the working
    // directory. Live mode runs the server from server/, so the key comes from
    // the server's own env (server/.env or an exported GEMINI_API_KEY) and
    // never passes through this config. The deterministic run points dotenv
    // at an empty file, so its server only ever sees the env given here; the
    // dummy key also overrides an exported one.
    cwd: LIVE ? 'server' : '.',
    env: LIVE
      ? { PORT: String(PORT), DOTENV_CONFIG_QUIET: 'true', LOG_LEVEL: 'warn' }
      : {
          PORT: String(PORT),
          DOTENV_CONFIG_PATH: '/dev/null',
          DOTENV_CONFIG_QUIET: 'true',
          GEMINI_API_KEY: 'e2e-dummy',
          LOG_LEVEL: 'warn',
        },
  },
});
