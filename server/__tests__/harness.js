import pino from 'pino';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../app.js';

// Shared by app.test.js and clientLog.test.js: createApp with a stubbed mint,
// an injected clock and a logger whose lines the test can read.

export const HOST = 'agent.test';
export const ORIGIN = `http://${HOST}`;
export const NONCE_ATTR = /data-ds-nonce="([0-9a-f-]{36})"/;

export function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A pino logger whose JSON lines land in `lines`, so tests can read what was logged. */
export function capturingLogger() {
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  const logger = pino({ level: 'debug' }, { write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

export function setup(overrides = {}) {
  const c = clock();
  const { logger, lines } = capturingLogger();
  const mintToken = vi.fn(async () => 'auth_tokens/stub-token');
  const app = createApp({ mintToken, now: c.now, logger, ...overrides });
  return { app, clock: c, mintToken, lines };
}

/** Serves the sandbox page the way a browser would and returns the nonce it embedded. */
export async function pageNonce(app, path = '/') {
  const res = await request(app).get(path).set('Host', HOST);
  const match = NONCE_ATTR.exec(res.text);
  if (!match) throw new Error(`no nonce in ${path}`);
  return match[1];
}
