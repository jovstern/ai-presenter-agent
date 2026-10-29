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

  it('turns a failed mint into a 500 without internals, logged with the request id', async () => {
    const mintToken = vi.fn(async () => {
      throw new Error('upstream said: key AIza-secret-detail is suspended');
    });
    const { app, lines } = setup({ mintToken });
    const nonce = await pageNonce(app);

    const res = await tokenRequest(app, nonce);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    expect(res.text).not.toMatch(/secret/);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toBeTruthy();
    const errorLine = lines.find((line) => line.msg === 'request failed');
    expect(errorLine).toMatchObject({ reqId: requestId });
    expect(JSON.stringify(errorLine)).toMatch(/secret-detail/); // the detail stays server-side
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

  it('serves the static directories', async () => {
    const { app } = setup();
    for (const path of ['/sandbox/bridge.js', '/target-app/home.js', '/target-app/settings.js']) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
  });
});
