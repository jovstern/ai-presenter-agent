import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import pino from 'pino';
import { createApp } from './app.js';

/** @import { MintToken } from './app.js' */

// The process half of the server: env, the real Gemini mint, listen and a
// graceful shutdown. Everything testable lives in app.js.

// JSON lines on stdout, which is what Render's log viewer reads.
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = Number(process.env.PORT) || 3000;
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * @param {string} apiKey
 * @returns {MintToken}
 */
function createGeminiMint(apiKey) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  return async ({ expiresAt }) => {
    const token = await ai.authTokens.create({
      config: { uses: 1, newSessionExpireTime: expiresAt.toISOString() },
    });
    if (!token.name) throw new Error('Gemini returned an auth token without a name');
    return token.name;
  };
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) logger.warn('GEMINI_API_KEY is not set; /api/live-token will answer not_configured');

const app = createApp({
  mintToken: apiKey ? createGeminiMint(apiKey) : undefined,
  logger,
  production: process.env.NODE_ENV === 'production',
});

const server = app.listen(PORT, () => {
  logger.info({ url: `http://localhost:${PORT}` }, 'server listening');
});

// Render sends SIGTERM on every deploy and restart: stop accepting new
// connections, let in-flight requests (a token mint) finish, then exit. A
// connection that never ends (a keep-alive the client holds) gets the grace
// period, then the process exits anyway.
// One shutdown only: SIGINT then SIGTERM (a Ctrl-C, then the supervisor) would
// otherwise call server.close twice, and the second call's
// ERR_SERVER_NOT_RUNNING exited 1 before in-flight requests had finished.
let shuttingDown = false;

/** @param {NodeJS.Signals} signal */
function shutdown(signal) {
  if (shuttingDown) {
    logger.info({ signal }, 'already shutting down');
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close((err) => {
    if (err) logger.error({ err }, 'error while closing the server');
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
  setTimeout(() => {
    logger.warn('shutdown grace period over; exiting');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
