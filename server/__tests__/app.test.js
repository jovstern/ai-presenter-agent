import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../app.js';

const HOST = 'agent.test';
const ORIGIN = `http://${HOST}`;
const NONCE_ATTR = /data-ds-nonce="([0-9a-f-]{36})"/;

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A pino logger whose JSON lines land in `lines`, so tests can read what was logged. */
function capturingLogger() {
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  const logger = pino({ level: 'debug' }, { write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

function setup(overrides = {}) {
  const c = clock();
  const { logger, lines } = capturingLogger();
  const mintToken = vi.fn(async () => 'auth_tokens/stub-token');
  const app = createApp({ mintToken, now: c.now, logger, ...overrides });
  return { app, clock: c, mintToken, lines };
}

/** Serves the sandbox page the way a browser would and returns the nonce it embedded. */
async function pageNonce(app, path = '/') {
  const res = await request(app).get(path).set('Host', HOST);
  const match = NONCE_ATTR.exec(res.text);
  if (!match) throw new Error(`no nonce in ${path}`);
  return match[1];
}

function tokenRequest(app, nonce, { origin = ORIGIN } = {}) {
  const req = request(app).get('/api/live-token').set('Host', HOST);
  if (nonce !== undefined) req.query({ nonce });
  return origin ? req.set('Origin', origin) : req;
}

describe('GET /api/live-token', () => {
  it('returns a token from the injected mint for a same-origin request with a valid nonce', async () => {
    const { app, mintToken, clock: c } = setup();
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'auth_tokens/stub-token' });
    // The Gemini token's new-session window is 60 s from the injected clock.
    expect(mintToken).toHaveBeenCalledWith({ expiresAt: new Date(c.now() + 60_000) });
  });

  it('accepts a same-origin Referer when the browser omits Origin', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce, { origin: null }).set('Referer', `${ORIGIN}/`);

    expect(res.status).toBe(200);
  });

  it('rejects a cross-origin request with 403 in the one error shape', async () => {
    const { app, mintToken } = setup();
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce, { origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: 'cross_origin', message: expect.any(String) },
    });
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('rejects a request with neither Origin nor Referer with 403', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce, { origin: null });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('cross_origin');
  });

  it('rejects a well-formed nonce this server never issued with 403', async () => {
    const { app, mintToken } = setup();

    const res = await tokenRequest(app, '00000000-0000-4000-8000-000000000000');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_nonce');
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('rejects a missing, malformed or repeated nonce query with 400 (Zod)', async () => {
    const { app } = setup();
    const nonce = await pageNonce(app);

    const missing = await tokenRequest(app, undefined);
    const malformed = await tokenRequest(app, 'not-a-uuid');
    const repeated = await request(app)
      .get(`/api/live-token?nonce=${nonce}&nonce=${nonce}`)
      .set('Host', HOST)
      .set('Origin', ORIGIN);

    for (const res of [missing, malformed, repeated]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });

  it('rejects an expired nonce with 403', async () => {
    const { app, clock: c } = setup();
    const nonce = await pageNonce(app);

    c.advance(60 * 60_000 + 1);
    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_nonce');
  });

  it('returns 429 past the per-IP limit, and serves again once the window has passed', async () => {
    const { app, clock: c } = setup({ limits: { rateLimitMax: 3 } });
    const nonce = await pageNonce(app);

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await tokenRequest(app, nonce)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await tokenRequest(app, nonce);
    expect(limited.body.error.code).toBe('rate_limited');

    c.advance(60_001);
    expect((await tokenRequest(app, nonce)).status).toBe(200);
  });

  it('returns a clean JSON 500 marked not_configured when there is no key (no mint)', async () => {
    const { app } = setup({ mintToken: undefined });
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    expect(res.body).toEqual({
      error: { code: 'not_configured', message: expect.any(String) },
    });
    expect(res.text).not.toMatch(/GEMINI_API_KEY/);
  });

  // The SDK's ApiError carries Google's own status: 400 API_KEY_INVALID for a
  // bad key. That is the server's fault, not the caller's, and no reload or
  // retry fixes it (docs/metrics/m05.md finding 1).
  it.each([400, 401, 403])(
    'answers an upstream %i from the mint as 500 not_configured, logged at error with the request id',
    async (upstreamStatus) => {
      const mintToken = vi.fn(async () => {
        throw Object.assign(new Error('API key not valid: AIza-secret-detail'), {
          status: upstreamStatus,
        });
      });
      const { app, lines } = setup({ mintToken });
      const nonce = await pageNonce(app);

      const res = await tokenRequest(app, nonce);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'not_configured', message: "The server isn't configured to connect" },
      });
      expect(res.text).not.toMatch(/secret/);
      const failure = lines.find((line) => line.msg === 'live token mint failed');
      expect(failure).toMatchObject({ level: 50, reqId: res.headers['x-request-id'] });
      expect(JSON.stringify(failure)).toMatch(/secret-detail/); // the detail stays server-side
      expect(lines.some((line) => line.level === 40)).toBe(false);
    },
  );

  it.each([
    ['an upstream 503', Object.assign(new Error('unavailable'), { status: 503 })],
    ['an upstream 429', Object.assign(new Error('quota'), { status: 429 })],
    ['a network error with no status', new TypeError('fetch failed')],
  ])('answers %s from the mint as 502 upstream_error, logged at error', async (_name, error) => {
    const mintToken = vi.fn(async () => {
      throw error;
    });
    const { app, lines } = setup({ mintToken });
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { code: 'upstream_error', message: expect.any(String) } });
    const failure = lines.find((line) => line.msg === 'live token mint failed');
    expect(failure).toMatchObject({ level: 50, reqId: res.headers['x-request-id'] });
  });

  it('never logs the nonce or the token', async () => {
    const { app, lines } = setup();
    const nonce = await pageNonce(app);

    await tokenRequest(app, nonce);

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(nonce);
    expect(logged).not.toContain('stub-token');
    expect(lines.some((line) => line.msg === 'live token minted')).toBe(true);
  });

  it('caps the nonce map: the oldest nonce is evicted once the cap is reached', async () => {
    const { app } = setup({ limits: { maxNonces: 2 } });
    const first = await pageNonce(app);
    await pageNonce(app);
    await pageNonce(app);

    expect((await tokenRequest(app, first)).status).toBe(403);
  });
});

describe('the sandbox page', () => {
  it.each(['/', '/sandbox', '/sandbox/', '/sandbox/index.html'])(
    '%s is templated with a fresh nonce on the agent script tag (M4 T1 regression)',
    async (path) => {
      const { app } = setup();
      const res = await request(app).get(path).set('Host', HOST);

      expect(res.status).toBe(200);
      expect(res.type).toBe('text/html');
      expect(res.text).not.toContain('%%DS_NONCE%%');
      expect(res.text).toMatch(NONCE_ATTR);
    },
  );

  // Every page load issues a nonce (an hour-long map entry), so a flood of
  // page loads from one address is capped like token requests are.
  it('returns 429 past the per-IP page limit, and serves again once the window has passed', async () => {
    const { app, clock: c } = setup({ limits: { pageRateLimitMax: 3 } });
    const load = () => request(app).get('/').set('Host', HOST);

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await load()).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await load();
    expect(limited.body).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
    expect(limited.text).not.toMatch(/data-ds-nonce/);

    c.advance(60_001);
    expect((await load()).status).toBe(200);
  });

  it('answers a browser past the page limit with an HTML page that says to wait, and Retry-After', async () => {
    const { app } = setup({ limits: { pageRateLimitMax: 1 } });
    const load = () => request(app).get('/').set('Host', HOST).set('Accept', 'text/html,*/*;q=0.8');
    await load();

    const res = await load();

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.type).toBe('text/html');
    expect(res.text).toMatch(/<title>Too many reloads<\/title>/);
    expect(res.text).toMatch(/<h1>Too many reloads<\/h1>/);
    expect(res.text).toMatch(/Wait a minute, then reload this page\./);
    expect(res.text).toMatch(/<a href="\/">Try again<\/a>/);
    expect(res.text).not.toMatch(/<script/);
    expect(res.text).not.toMatch(/data-ds-nonce/);
  });

  it('answers a non-HTML caller past the page limit in the JSON error shape, with Retry-After', async () => {
    const { app } = setup({ limits: { pageRateLimitMax: 1 } });
    await request(app).get('/').set('Host', HOST);

    const res = await request(app).get('/').set('Host', HOST).set('Accept', 'application/json');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
  });

  it('counts page loads and token requests separately', async () => {
    const { app } = setup({ limits: { pageRateLimitMax: 1, rateLimitMax: 1 } });
    const nonce = await pageNonce(app);

    expect((await tokenRequest(app, nonce)).status).toBe(200);
  });

  it('allows 60 page loads a minute by default', async () => {
    const { app } = setup();
    const statuses = [];
    for (let i = 0; i < 61; i += 1) {
      statuses.push((await request(app).get('/sandbox/').set('Host', HOST)).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
  });

  it('issues a different nonce per page load', async () => {
    const { app } = setup();
    expect(await pageNonce(app)).not.toBe(await pageNonce(app));
  });

  it('ships no inline script', async () => {
    const { app } = setup();
    const res = await request(app).get('/').set('Host', HOST);
    const scripts = res.text.match(/<script\b[^>]*>/g) ?? [];

    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\bsrc="/);
  });

  it.each(['/target-app/index.html', '/target-app/settings.html'])(
    '%s ships no inline script',
    async (path) => {
      const { app } = setup();
      const res = await request(app).get(path).set('Host', HOST);

      expect(res.status).toBe(200);
      const scripts = res.text.match(/<script\b[^>]*>/g) ?? [];
      for (const tag of scripts) expect(tag).toMatch(/\bsrc="/);
    },
  );
});

describe('headers', () => {
  function cspOf(res) {
    return Object.fromEntries(
      res.headers['content-security-policy']
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values.join(' ')]),
    );
  }

  it('sends the CSP on the sandbox page', async () => {
    const { app } = setup();
    const res = await request(app).get('/').set('Host', HOST);
    const csp = cspOf(res);

    expect(csp['default-src']).toBe("'self'");
    expect(csp['script-src']).toBe("'self'");
    expect(csp['style-src']).toBe("'self' 'unsafe-inline'");
    expect(csp['connect-src']).toBe(
      "'self' wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com",
    );
    expect(csp['frame-src']).toBe("'self'");
    expect(csp['img-src']).toBe("'self' data:");
    expect(csp).not.toHaveProperty('upgrade-insecure-requests');
    expect(res.headers).not.toHaveProperty('strict-transport-security');
  });

  it('adds upgrade-insecure-requests and HSTS in production only', async () => {
    const { app } = setup({ production: true });
    const res = await request(app).get('/').set('Host', HOST);

    expect(cspOf(res)).toHaveProperty('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  // Found in the real browser: helmet's default no-referrer stripped the
  // Referer that Chrome's same-origin fetch() sends instead of Origin, so the
  // token gate rejected the page's own requests as cross-origin.
  it('keeps Referer on same-origin requests (the token gate depends on it)', async () => {
    const { app } = setup();
    const res = await request(app).get('/').set('Host', HOST);
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('does not send x-powered-by', async () => {
    const { app } = setup();
    const res = await request(app).get('/health');
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });
});

describe('other routes', () => {
  it('GET /health is 200 {ok:true}', async () => {
    const { app } = setup();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('an unknown path is a JSON 404 in the one error shape', async () => {
    const { app } = setup();
    const res = await request(app).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('an unknown page a browser asks for is an accessible HTML 404 with a way back', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/target-app/missing.html')
      .set('Host', HOST)
      .set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');

    expect(res.status).toBe(404);
    expect(res.type).toBe('text/html');
    expect(res.text).toMatch(/<html lang="en">/);
    expect(res.text).toMatch(/<title>Page not found<\/title>/);
    expect(res.text).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1"/);
    expect(res.text).toMatch(/<h1>Page not found<\/h1>/);
    expect(res.text).toMatch(/<a href="\/">Back to the demo<\/a>/);
    expect(res.text).not.toMatch(/<script/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
  });

  it('an unknown /api/ path stays JSON even for a browser', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/nope').set('Accept', 'text/html');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  // The error handler, reached through a route that throws: the injected
  // clock is the token route's first dependency, so a throwing one stands in
  // for any unexpected failure.
  function throwingClock(error) {
    const c = clock();
    let broken = false;
    return {
      now: () => {
        if (broken) throw error;
        return c.now();
      },
      breakNow: () => {
        broken = true;
      },
    };
  }

  it('turns a plain thrown error into a 500 internal, logged at error with the request id', async () => {
    const c = throwingClock(new Error('boom: internal-detail'));
    const { app, lines } = setup({ now: c.now });
    const nonce = await pageNonce(app);
    c.breakNow();

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    expect(res.text).not.toMatch(/internal-detail/);
    expect(lines.find((line) => line.msg === 'request failed')).toMatchObject({
      level: 50,
      reqId: res.headers['x-request-id'],
    });
  });

  it('ignores the status of an error that does not set expose (not a client error)', async () => {
    const c = throwingClock(Object.assign(new Error('upstream'), { status: 400 }));
    const { app } = setup({ now: c.now });
    const nonce = await pageNonce(app);
    c.breakNow();

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
  });

  it('keeps the status of an exposed client error (http-errors), logged at warn', async () => {
    const c = throwingClock(Object.assign(new Error('Bad Request'), { status: 400, expose: true }));
    const { app, lines } = setup({ now: c.now });
    const nonce = await pageNonce(app);
    c.breakNow();

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'bad_request', message: 'Bad Request' } });
    expect(lines.find((line) => line.msg === 'request rejected')).toMatchObject({ level: 40 });
  });

  it('serves the static directories', async () => {
    const { app } = setup();
    for (const path of ['/sandbox/bridge.js', '/target-app/home.js', '/target-app/settings.js']) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
  });
});
