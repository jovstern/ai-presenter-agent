import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { HOST, ORIGIN, pageNonce, setup } from './harness.js';

// POST /api/client-log (M8 T2, spec R23): the agent-client's error, vitals and
// connection-failure beacons. Same gates as the token route, its own rate
// limit, a Zod body, a 4 kB cap, 204, one pino line per report.

const VITAL = { type: 'vital', name: 'LCP', value: 1234.5, rating: 'good', id: 'v5-1730000000-1' };
const ERROR = {
  type: 'error',
  message: 'TypeError: x is undefined',
  source: 'http://agent.test/agent-client/agent-client.js:1:200',
  stack:
    'TypeError: x is undefined\n    at f (http://agent.test/agent-client/agent-client.js:1:200)',
};
const CONNECTION = {
  type: 'connection',
  kind: 'exhausted',
  reason: 'Could not reconnect after 6 attempts.',
  attempt: 6,
};

/**
 * A beacon the way navigator.sendBeacon sends one: a POST with the nonce in
 * the query (it can't set headers) and a JSON Blob body.
 * @param {import('express').Express} app
 * @param {string | undefined} nonce
 * @param {unknown} body
 * @param {{ origin?: string | null }} [options]
 */
function beacon(app, nonce, body, { origin = ORIGIN } = {}) {
  const req = request(app)
    .post('/api/client-log')
    .set('Host', HOST)
    .set('Content-Type', 'application/json');
  if (nonce !== undefined) req.query({ nonce });
  if (origin) req.set('Origin', origin);
  return req.send(typeof body === 'string' ? body : JSON.stringify(body));
}

/** @param {Record<string, unknown>[]} lines */
const clientLines = (lines) => lines.filter((line) => line.client !== undefined);

describe('POST /api/client-log', () => {
  it('accepts a vital with 204 and logs it at info with the request id', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, VITAL);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(clientLines(lines)).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'client vital',
        reqId: res.headers['x-request-id'],
        client: VITAL,
      }),
    ]);
  });

  it('accepts an error and logs it at warn', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, ERROR);

    expect(res.status).toBe(204);
    expect(clientLines(lines)).toEqual([
      expect.objectContaining({ level: 40, msg: 'client error', client: ERROR }),
    ]);
  });

  it('accepts an error with no source or stack', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, { type: 'error', message: 'boom' });

    expect(res.status).toBe(204);
    expect(clientLines(lines)[0].client).toEqual({ type: 'error', message: 'boom' });
  });

  it.each(['config', 'token', 'exhausted'])(
    'accepts a %s connection failure and logs it at warn',
    async (kind) => {
      const { app, lines } = setup();
      const nonce = await pageNonce(app);

      const res = await beacon(app, nonce, { ...CONNECTION, kind });

      expect(res.status).toBe(204);
      expect(clientLines(lines)).toEqual([
        expect.objectContaining({
          level: 40,
          msg: 'client connection failed',
          reqId: res.headers['x-request-id'],
          client: { ...CONNECTION, kind },
        }),
      ]);
    },
  );

  it('accepts a connection failure with no reason', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);
    const noReason = { type: 'connection', kind: 'exhausted', attempt: 6 };

    expect((await beacon(app, nonce, noReason)).status).toBe(204);
    expect(clientLines(lines)[0].client).toEqual(noReason);
  });

  it('accepts a Referer when the browser sends no Origin', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, VITAL, { origin: null }).set('Referer', `${ORIGIN}/`);

    expect(res.status).toBe(204);
  });

  it('logs only the schema fields: unknown keys are dropped', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    await beacon(app, nonce, { ...VITAL, extra: 'not logged', attribution: { x: 1 } });

    expect(clientLines(lines)[0].client).toEqual(VITAL);
  });

  it('truncates long strings', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, {
      type: 'error',
      message: 'm'.repeat(600),
      source: 's'.repeat(400),
      stack: 'x'.repeat(2500),
    });

    expect(res.status).toBe(204);
    const { client } = clientLines(lines)[0];
    expect(client.message).toHaveLength(500);
    expect(client.source).toHaveLength(300);
    expect(client.stack).toHaveLength(2000);
  });

  it('strips query strings and fragments from URLs, and token-shaped values, before logging', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, {
      type: 'error',
      message: `WebSocket wss://generativelanguage.googleapis.com/ws/Live?access_token=auth_tokens/abc123 failed; key=AIzaSecret`,
      source: `${ORIGIN}/api/live-token?nonce=${nonce}#frag`,
      stack: `Error\n    at ${ORIGIN}/agent-client/agent-client.js?v=1:1:2`,
    });

    expect(res.status).toBe(204);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(nonce);
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('AIzaSecret');
    expect(logged).not.toContain('frag');
    const { client } = clientLines(lines)[0];
    expect(client.message).toBe(
      'WebSocket wss://generativelanguage.googleapis.com/ws/Live failed; key=[redacted]',
    );
    expect(client.source).toBe(`${ORIGIN}/api/live-token`);
    expect(client.stack).toBe(`Error\n    at ${ORIGIN}/agent-client/agent-client.js`);
  });

  it('never logs the nonce, in the request line or the report', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    await beacon(app, nonce, VITAL);

    expect(JSON.stringify(lines)).not.toContain(nonce);
  });

  it.each([
    ['an unknown type', { type: 'debug', message: 'x' }],
    ['no type', { message: 'x' }],
    ['a vital outside the reported set', { ...VITAL, name: 'FID' }],
    ['a vital with a bad rating', { ...VITAL, rating: 'great' }],
    ['a negative vital', { ...VITAL, value: -1 }],
    ['a vital value that is not a number', { ...VITAL, value: '12' }],
    ['a vital id with odd characters', { ...VITAL, id: 'a b<c>' }],
    ['an error with no message', { type: 'error' }],
    ['a connection failure of an unknown kind', { ...CONNECTION, kind: 'network' }],
    ['a connection failure with a fractional attempt', { ...CONNECTION, attempt: 1.5 }],
    ['an array', [VITAL]],
  ])('rejects %s with 400 invalid_request and logs no report', async (_, body) => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(clientLines(lines)).toEqual([]);
  });

  it('rejects malformed JSON with 400 invalid_request, without logging the body', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, '{"type":"error","message":"secret-ish');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(JSON.stringify(lines)).not.toContain('secret-ish');
  });

  it('rejects a body that is not JSON with 400 invalid_request', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const res = await request(app)
      .post('/api/client-log')
      .query({ nonce })
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(VITAL));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('rejects a body over 4 kB with 413 payload_too_large, before parsing it', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);
    const body = JSON.stringify({ type: 'error', message: 'x'.repeat(4096) });

    const res = await beacon(app, nonce, body);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: { code: 'payload_too_large', message: 'The report is larger than 4 kB' },
    });
    expect(clientLines(lines)).toEqual([]);
    expect(lines.find((line) => line.msg === 'client log rejected')).toMatchObject({ level: 40 });
  });

  it('accepts a body just under 4 kB', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);
    const body = JSON.stringify({ type: 'error', message: 'x', stack: 'y'.repeat(3900) });
    expect(body.length).toBeLessThan(4096);

    expect((await beacon(app, nonce, body)).status).toBe(204);
  });

  it('rejects a cross-origin beacon with 403 cross_origin', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    const res = await beacon(app, nonce, VITAL, { origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('cross_origin');
    expect(clientLines(lines)).toEqual([]);
  });

  it('rejects a beacon with neither Origin nor Referer with 403', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    expect((await beacon(app, nonce, VITAL, { origin: null })).status).toBe(403);
  });

  it('rejects a well-formed nonce this server never issued with 403 invalid_nonce', async () => {
    const { app, lines } = setup();
    await pageNonce(app);

    const res = await beacon(app, crypto.randomUUID(), VITAL);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_nonce');
    expect(clientLines(lines)).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-uuid'],
  ])('rejects a %s nonce with 400 invalid_request', async (_, nonce) => {
    const { app } = setup();

    const res = await beacon(app, nonce, VITAL);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('rejects an expired nonce with 403', async () => {
    const { app, clock } = setup({ limits: { nonceTtlMs: 1000 } });
    const nonce = await pageNonce(app);
    clock.advance(1001);

    expect((await beacon(app, nonce, VITAL)).status).toBe(403);
  });

  it('returns 429 past its own per-IP limit, and accepts again once the window has passed', async () => {
    const { app, clock, lines } = setup({ limits: { clientLogRateLimitMax: 2 } });
    const nonce = await pageNonce(app);

    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await beacon(app, nonce, VITAL)).status);
    expect(statuses).toEqual([204, 204, 429]);
    expect((await beacon(app, nonce, VITAL)).body.error.code).toBe('rate_limited');
    expect(clientLines(lines)).toHaveLength(2);

    clock.advance(60_001);
    expect((await beacon(app, nonce, VITAL)).status).toBe(204);
  });

  it('has a limit separate from the token route: log spam does not eat the token budget', async () => {
    const { app } = setup({ limits: { clientLogRateLimitMax: 1, rateLimitMax: 1 } });
    const nonce = await pageNonce(app);

    expect((await beacon(app, nonce, VITAL)).status).toBe(204);
    expect((await beacon(app, nonce, VITAL)).status).toBe(429);
    const token = await request(app)
      .get('/api/live-token')
      .query({ nonce })
      .set('Host', HOST)
      .set('Origin', ORIGIN);
    expect(token.status).toBe(200);
  });

  it('allows 60 reports a minute per IP by default', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const statuses = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await beacon(app, nonce, VITAL)).status);
    expect(statuses.filter((s) => s === 204)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
  });

  it('answers only POST: a GET is the JSON 404', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const res = await request(app)
      .get('/api/client-log')
      .query({ nonce })
      .set('Host', HOST)
      .set('Origin', ORIGIN);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
