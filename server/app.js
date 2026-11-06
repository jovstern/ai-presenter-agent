import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { createExpiringMap } from './expiringMap.js';

/** @import { NextFunction, Request, Response } from 'express' */
/** @import { Logger } from 'pino' */

// The Express app with no listen(), so tests drive it with supertest
// (index.js reads the env, listens and shuts down). A scaled-down
// .claude/skills/stack-conventions/node-api.md: one route that does real
// work does not earn a routes/ + services/ tree (recorded in the spec's
// Assumptions and the plan's M5 T3).

/**
 * Mints one Gemini Live ephemeral token. Injected so tests never call Google;
 * index.js passes the real one only when GEMINI_API_KEY is set.
 * @callback MintToken
 * @param {{ expiresAt: Date }} options When a new Live session may no longer start with it.
 * @returns {Promise<string>} The token's name, which the client uses as its API key.
 */

/**
 * @typedef {object} AppOptions
 * @property {MintToken} [mintToken] Absent when the server has no API key.
 * @property {() => number} [now] Epoch ms; injected so tests control expiry.
 * @property {Logger} logger
 * @property {boolean} [production] Adds HSTS and upgrade-insecure-requests.
 * @property {number} [trustProxyHops] Express `trust proxy` hop count; 0 (the
 *   default) ignores X-Forwarded-* entirely.
 * @property {Partial<typeof DEFAULT_LIMITS>} [limits]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DEFAULT_LIMITS = {
  // Token requests per IP per window.
  rateLimitMax: 30,
  // Sandbox page loads per IP per window: each one issues a nonce (see
  // sendSandbox). Generous, since a viewer may reload often.
  pageRateLimitMax: 60,
  rateLimitWindowMs: 60_000,
  // 1 hour: long enough for a real demo session (see the H1 note below).
  nonceTtlMs: 60 * 60_000,
  // Caps for the in-memory maps (deferred from M4: they grew without limit).
  // Far above what one small instance sees in an hour; past them the oldest
  // entry goes, so a flood costs a stale page a reload, not memory. The page
  // rate limit (pageRateLimitMax) keeps one address from causing that flood
  // alone; many addresses still can, which costs only those reloads.
  maxNonces: 10_000,
  maxClients: 10_000,
  // Client-log beacons per IP per window (POST /api/client-log), counted apart
  // from token requests so a noisy page can't spend a viewer's token budget.
  // A page sends at most 20 (agent-client/src/clientLog.js).
  clientLogRateLimitMax: 60,
};

// A live Gemini token may only start a session within this window.
const TOKEN_SESSION_WINDOW_MS = 60_000;

const GEMINI_ORIGINS = [
  'wss://generativelanguage.googleapis.com',
  'https://generativelanguage.googleapis.com',
];

// The nonce is a crypto.randomUUID(); anything else (missing, repeated
// `?nonce=a&nonce=b` which Express parses to an array, junk) is a malformed
// request, not a wrong nonce.
const TokenQuery = z.object({ nonce: z.uuid() });

// The client log's body cap. A report is a few hundred bytes; past this the
// JSON parser refuses it unread (413).
const CLIENT_LOG_LIMIT = '4kb';

// What a client-log string may carry into a log line: URLs lose their query
// and fragment (the Live socket URL carries the token as access_token=, the
// token route's the page nonce), and key=value pairs, token names and Google
// API keys that slip through are masked. Then the length cap.
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#'"()<>]*)[?#][^\s'"()<>]*/gi;
const SECRET_PAIR = /\b(access_token|token|key|api_key|apikey|nonce|password|secret)=[^\s&'"]+/gi;
const TOKEN_NAME = /\bauth_tokens\/[\w.-]+/g;
const GOOGLE_API_KEY = /\bAIza[\w-]{35}\b/g;

/**
 * @param {string} text
 * @param {number} max
 */
export function redact(text, max) {
  return text
    .replace(URL_QUERY, '$1')
    .replace(SECRET_PAIR, '$1=[redacted]')
    .replace(TOKEN_NAME, 'auth_tokens/[redacted]')
    .replace(GOOGLE_API_KEY, '[redacted]')
    .slice(0, max);
}

/** @param {number} max */
const loggedText = (max) => z.string().transform((text) => redact(text, max));

// One beacon from agent-client/src/clientLog.js (spec R23). Unknown keys are
// dropped, so only these fields reach the log.
const ClientReport = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('error'),
    message: loggedText(500),
    source: loggedText(300).optional(),
    stack: loggedText(2000).optional(),
  }),
  z.object({
    type: z.literal('vital'),
    // The metrics clientLog.js reports, and no others.
    name: z.enum(['LCP', 'INP', 'CLS']),
    value: z.number().finite().nonnegative(),
    rating: z.enum(['good', 'needs-improvement', 'poor']),
    id: z.string().regex(/^[\w.-]{1,64}$/),
  }),
  z.object({
    type: z.literal('connection'),
    // liveSession.js's FatalKind, or `exhausted`: the backoff ran out.
    kind: z.enum(['config', 'token', 'exhausted']),
    reason: loggedText(200).optional(),
    attempt: z.number().int().min(0).max(100),
  }),
]);

/** @type {Record<z.infer<typeof ClientReport>['type'], { level: 'info' | 'warn', msg: string }>} */
const CLIENT_LOG_LINES = {
  error: { level: 'warn', msg: 'client error' },
  vital: { level: 'info', msg: 'client vital' },
  connection: { level: 'warn', msg: 'client connection failed' },
};

// target-app/routes.json, the one route list (docs/code-review-notes.md M1):
// route name -> the page's absolute path. bridge.js and actionTools.js both
// derive from it, so a bad file fails the server's start, not a demo.
const Routes = z
  .record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().regex(/^\/target-app\/[\w-]+\.html$/))
  .refine((routes) => Object.keys(routes).length > 0, 'no routes');

/**
 * JSON for a `<script type="application/json">` data block. Every `<` is
 * escaped, so no value can close the tag (`</script>`) or open a comment.
 * @param {unknown} value
 */
export function jsonForScriptBlock(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * The one error shape for every JSON error (node-api.md).
 * @param {Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

const NOT_CONFIGURED_MESSAGE = "The server isn't configured to connect";

// The upstream statuses that mean the server's own key is bad or revoked.
const MISCONFIGURED_UPSTREAM_STATUSES = new Set([400, 401, 403]);

/**
 * @param {unknown} err
 * @returns {number | undefined} The error's numeric `status`, if it has one.
 */
function statusOf(err) {
  return typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number'
    ? err.status
    : undefined;
}

/** @param {unknown} err A mint rejection. */
function isMisconfiguredUpstream(err) {
  const status = statusOf(err);
  return status !== undefined && MISCONFIGURED_UPSTREAM_STATUSES.has(status);
}

/** @param {Request} req */
function isSameOrigin(req) {
  const expected = `${req.protocol}://${req.get('host')}`;
  const origin = req.get('origin');
  if (origin) return origin === expected;

  // Chrome's fetch() omits Origin for same-origin requests (confirmed against
  // this exact endpoint), so falling back to Referer isn't optional — it's
  // the only signal a legitimate same-origin call actually sends. No Origin
  // AND no Referer (curl, a bare HTTP client, most non-browser callers) is
  // rejected rather than waved through.
  const referer = req.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

/**
 * The CSP for every response (docs/code-review-notes.md H1). Any later task
 * that adds a resource type (a worklet, a stylesheet, a beacon) updates this
 * in the same commit — the plan's Global constraints.
 * @param {boolean} production
 */
function contentSecurityPolicy(production) {
  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No inline script on any served page: the target app's scripts are
      // files, and the page nonce rides on a data- attribute (sandbox/index.html).
      // Also governs worklets: the mic capture worklet is a same-origin file
      // (/agent-client/capture-worklet.js), so no blob: is needed (M6 T3).
      scriptSrc: ["'self'"],
      // 'unsafe-inline' on purpose: the agent-client's shadow root gets its
      // stylesheet as a runtime <style> element (main.jsx), and Radix Dialog's
      // react-remove-scroll injects a <style> and inline style attributes
      // when the knowledge dialog opens. Neither can carry a per-response
      // nonce from a prebuilt bundle.
      styleSrc: ["'self'", "'unsafe-inline'"],
      // The Gemini Live socket, plus its HTTPS origin for any REST call the SDK makes.
      connectSrc: ["'self'", ...GEMINI_ORIGINS],
      frameSrc: ["'self'"],
      // The pages' favicon is `data:,` (an empty icon, so no /favicon.ico 404).
      imgSrc: ["'self'", 'data:'],
      // Hardening beyond the task's list, all no-ops for this app's own pages.
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      // Local dev runs on plain http://localhost, where this would break every request.
      ...(production ? { upgradeInsecureRequests: [] } : {}),
    },
  };
}

/** @type {Record<string, string>} */
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Text made safe for an HTML element or a quoted attribute.
 * @param {string} text
 */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

/**
 * The one look for the server's own HTML pages (the 404 and the page-load
 * 429), so they match: a heading, a line of text and a link back to the
 * demo. Today's callers pass constants, but every argument is escaped anyway,
 * so a later caller passing a path or a message can't inject markup. No
 * script, under the same CSP as everything else.
 * @param {string} rawTitle
 * @param {string} rawText
 * @param {string} rawLinkText
 */
export function errorPage(rawTitle, rawText, rawLinkText) {
  const [title, text, linkText] = [rawTitle, rawText, rawLinkText].map(escapeHtml);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" href="data:," />
    <style>
      body { margin: 0; padding: 48px 16px; font-family: system-ui, sans-serif; color: #1a1a1a; background: #fff; }
      main { max-width: 32rem; margin: 0 auto; }
      h1 { font-size: 1.5rem; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #555; }
      a { color: #0b57d0; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${text}</p>
      <a href="/">${linkText}</a>
    </main>
  </body>
</html>
`;
}

const NOT_FOUND_HTML = errorPage(
  'Page not found',
  'There is nothing at this address.',
  'Back to the demo',
);
const TOO_MANY_RELOADS_HTML = errorPage(
  'Too many reloads',
  'Wait a minute, then reload this page.',
  'Try again',
);

/** @param {Request} req */
function prefersHtml(req) {
  return req.accepts(['json', 'html']) === 'html';
}

/**
 * A fixed window per IP: the entry's TTL is the window, and a hit inside it
 * mutates the count without restarting it. req.ip is undefined only for a
 * socket that's already gone; such requests share one bucket.
 * @param {{ max: number, windowMs: number, maxClients: number, now: () => number }} options
 * @returns {(req: Request) => boolean} Whether this request is over the limit.
 */
function createRateLimiter({ max, windowMs, maxClients, now }) {
  /** @type {import('./expiringMap.js').ExpiringMap<{ count: number }>} */
  const requestLog = createExpiringMap({ ttlMs: windowMs, maxSize: maxClients, now });
  return (req) => {
    const key = req.ip ?? '';
    const entry = requestLog.get(key);
    if (!entry) {
      requestLog.set(key, { count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

/** @param {AppOptions} options */
export function createApp({
  mintToken,
  now = Date.now,
  logger,
  production = false,
  trustProxyHops = 0,
  limits,
}) {
  const {
    rateLimitMax,
    pageRateLimitMax,
    clientLogRateLimitMax,
    rateLimitWindowMs,
    nonceTtlMs,
    maxNonces,
    maxClients,
  } = {
    ...DEFAULT_LIMITS,
    ...limits,
  };

  // Fix for docs/code-review-notes.md H1 (open token vending machine): gate on
  // same-origin, rate-limit per IP, and require a nonce that sandbox/index.html
  // carries at serve time and the client echoes back. This closes the
  // cross-origin-frame/other-window vector. It does NOT close the co-resident-
  // script vector H1 also describes — a hostile script already running on this
  // origin can read the script tag's data-ds-nonce attribute just like
  // agent-client does. What the nonce actually buys: a request must come from
  // a script that loaded on *this* page, not an arbitrary cross-origin/
  // cross-frame caller.
  //
  // Deliberately NOT single-use, despite H1's original wording: a live Gemini
  // token is itself single-use + 60s, so a real conversation fetches a fresh
  // one on every connect *and* every reconnect (network drop, session-cap
  // resumption). A single-use nonce made every reconnect after the first fail
  // with a 403 — caught by testing B2's reconnect path, not a theoretical
  // concern. Reusable within a generous TTL instead; a page open longer than
  // that needs a reload, which is an acceptable bar for this project's scope.
  /** @type {import('./expiringMap.js').ExpiringMap<true>} */
  const nonces = createExpiringMap({ ttlMs: nonceTtlMs, maxSize: maxNonces, now });
  const isRateLimited = createRateLimiter({
    max: rateLimitMax,
    windowMs: rateLimitWindowMs,
    maxClients,
    now,
  });
  const isPageRateLimited = createRateLimiter({
    max: pageRateLimitMax,
    windowMs: rateLimitWindowMs,
    maxClients,
    now,
  });
  const isClientLogRateLimited = createRateLimiter({
    max: clientLogRateLimitMax,
    windowMs: rateLimitWindowMs,
    maxClients,
    now,
  });

  /**
   * The page gate both API routes share: same origin, under `limited`, and a
   * nonce this server issued. Answers the request and returns false when it
   * fails.
   * @param {Request} req
   * @param {Response} res
   * @param {(req: Request) => boolean} limited
   */
  function passesPageGate(req, res, limited) {
    if (!isSameOrigin(req)) {
      sendError(res, 403, 'cross_origin', 'Cross-origin requests are not allowed');
      return false;
    }
    if (limited(req)) {
      sendError(res, 429, 'rate_limited', 'Too many requests');
      return false;
    }
    const query = TokenQuery.safeParse(req.query);
    if (!query.success) {
      sendError(res, 400, 'invalid_request', 'The nonce query parameter is missing or malformed');
      return false;
    }
    if (!nonces.get(query.data.nonce)) {
      sendError(res, 403, 'invalid_nonce', 'Unknown or expired nonce');
      return false;
    }
    return true;
  }

  // A1 (assessment): every URL that renders the sandbox page must go through
  // the nonce template, or the page ships the literal %%DS_NONCE%% and every
  // /api/live-token call fails (see H1 above). Read once: the files only
  // change on a deploy, which restarts the process anyway. The route list is
  // templated in here, once; only the nonce differs per load. A replacer
  // function, not a string, so a `$&` in the JSON is not a replace pattern.
  const routes = Routes.parse(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'target-app/routes.json'), 'utf8')),
  );
  const sandboxHtml = fs
    .readFileSync(path.join(ROOT, 'sandbox/index.html'), 'utf8')
    .replace('%%DS_ROUTES%%', () => jsonForScriptBlock(routes));

  const app = express();
  app.disable('x-powered-by');
  // Behind Render's TLS-terminating proxy (ADR 0003) the socket is plain http
  // from the proxy's address. Trusting its hop makes req.protocol https (from
  // X-Forwarded-Proto), so isSameOrigin matches the page's https Origin or
  // Referer, and makes req.ip the client (the last X-Forwarded-For entry),
  // so each viewer gets their own bucket in both rate limiters instead of
  // all sharing the proxy's. Off locally: there a client could otherwise
  // pick its own bucket with a forged X-Forwarded-For.
  app.set('trust proxy', trustProxyHops);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Manual req.log lines carry just `reqId`, not the whole request.
      quietReqLogger: true,
      // Render's health check polls /health (ADR 0003); a line per poll
      // would bury the real traffic.
      autoLogging: { ignore: (req) => req.url?.split('?')[0] === '/health' },
      serializers: {
        // The path only: the token route's query carries the page nonce,
        // which is a credential for an hour and never belongs in a log.
        req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: contentSecurityPolicy(production),
      // HSTS on localhost would pin the browser to https for every local port.
      strictTransportSecurity: production,
      // Not helmet's default no-referrer: Chrome's same-origin fetch() sends
      // no Origin, so the Referer is the token gate's only same-origin signal
      // (isSameOrigin). same-origin still sends nothing to other origins.
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  // Before every route: the agent-client bundle is ~620 kB raw and ~150 kB
  // gzipped, and serving it uncompressed made it the page's LCP bottleneck (M4
  // metrics, docs/metrics/m04.md: mobile LCP 4.26 s → 1.86 s with gzip).
  app.use(compression());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/live-token', async (req, res) => {
    if (!passesPageGate(req, res, isRateLimited)) return;
    if (!mintToken) {
      // `not_configured` tells the client not to burn its reconnect backoff on
      // this: no amount of retrying (or reloading) sets the key.
      sendError(res, 500, 'not_configured', NOT_CONFIGURED_MESSAGE);
      return;
    }

    const expiresAt = new Date(now() + TOKEN_SESSION_WINDOW_MS);
    /** @type {string} */
    let token;
    try {
      token = await mintToken({ expiresAt });
    } catch (err) {
      // The SDK's ApiError carries Google's own status, and its message can
      // carry upstream request details (A9, assessment): both stay in the log.
      // An upstream 400/401/403 (API_KEY_INVALID, a revoked key) is this
      // server's misconfiguration, not the caller's fault, and no retry or
      // reload fixes it: `not_configured`, which the client shows as fatal.
      // Anything else (5xx, quota, network) may pass: 502, which it retries.
      // Both are error-level, so a broken key shows up as a 5xx and an error
      // line (docs/metrics/m05.md finding 1).
      req.log.error({ err }, 'live token mint failed');
      if (isMisconfiguredUpstream(err)) {
        sendError(res, 500, 'not_configured', NOT_CONFIGURED_MESSAGE);
      } else {
        sendError(res, 502, 'upstream_error', 'The voice service did not answer');
      }
      return;
    }
    req.log.info('live token minted');
    res.json({ token });
  });

  // The agent-client's beacons (spec R23, agent-client/src/clientLog.js):
  // navigator.sendBeacon can't set headers, so the nonce rides in the query,
  // as on the token route. The gate runs before the body is read, so a
  // rejected caller costs no parsing. The JSON parser's own errors (over the
  // cap, malformed) are answered by clientLogParseError below, never logged
  // with their body.
  app.post(
    '/api/client-log',
    (req, res, next) => {
      if (passesPageGate(req, res, isClientLogRateLimited)) next();
    },
    express.json({ limit: CLIENT_LOG_LIMIT }),
    (req, res) => {
      const report = ClientReport.safeParse(req.body);
      if (!report.success) {
        sendError(res, 400, 'invalid_request', 'The report does not match any known shape');
        return;
      }
      const { level, msg } = CLIENT_LOG_LINES[report.data.type];
      req.log[level]({ client: report.data }, msg);
      res.status(204).end();
    },
  );

  /**
   * The client log's body-parser errors: 413 past the cap, 415 for a charset
   * or Content-Encoding it can't decode, 400 for anything else it refuses. Logged by type only: a parse error carries the raw body.
   * @param {unknown} err
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  function clientLogParseError(err, req, res, next) {
    const status = statusOf(err);
    if (status === undefined || status >= 500 || res.headersSent) {
      next(err);
      return;
    }
    const type =
      typeof err === 'object' && err !== null && 'type' in err ? String(err.type) : undefined;
    req.log.warn({ status, type }, 'client log rejected');
    if (status === 413) {
      sendError(res, 413, 'payload_too_large', 'The report is larger than 4 kB');
    } else if (status === 415) {
      sendError(res, 415, 'unsupported_media_type', 'The report must be UTF-8 JSON');
    } else {
      sendError(res, 400, 'invalid_request', 'The report is not valid JSON');
    }
  }
  app.use('/api/client-log', clientLogParseError);

  /**
   * Express 5 routing is non-strict, so '/sandbox' matches both '/sandbox' and
   * '/sandbox/'; the page's asset URLs are absolute, so no redirect is needed.
   * Registered before the /sandbox static mount so it never serves the
   * untemplated file.
   * @param {Request} req
   * @param {Response} res
   */
  function sendSandbox(req, res) {
    if (isPageRateLimited(req)) {
      // A viewer who reloads too fast gets a page that says what to do; the
      // fixed window resets within rateLimitWindowMs, so that's the wait.
      res.set('Retry-After', String(Math.ceil(rateLimitWindowMs / 1000)));
      if (prefersHtml(req)) {
        res.status(429).type('html').send(TOO_MANY_RELOADS_HTML);
      } else {
        sendError(res, 429, 'rate_limited', 'Too many requests');
      }
      return;
    }
    const nonce = crypto.randomUUID();
    nonces.set(nonce, true);
    res.type('html').send(sandboxHtml.replace('%%DS_NONCE%%', nonce));
  }

  app.get(['/', '/sandbox', '/sandbox/index.html'], sendSandbox);
  app.use('/agent-client', express.static(path.join(ROOT, 'agent-client/dist')));
  app.use('/sandbox', express.static(path.join(ROOT, 'sandbox')));
  app.use('/target-app', express.static(path.join(ROOT, 'target-app')));

  // A browser that follows a bad link gets a page with a way back; an API
  // caller (and anything that doesn't prefer HTML) gets the one error shape.
  app.use((req, res) => {
    if (!req.path.startsWith('/api/') && prefersHtml(req)) {
      res.status(404).type('html').send(NOT_FOUND_HTML);
      return;
    }
    sendError(res, 404, 'not_found', 'Not found');
  });

  /**
   * The central error handler (node-api.md): a client error that Express or
   * http-errors marked `expose` (a 4xx, e.g. a malformed URL) keeps its
   * status; anything else, including an upstream SDK error that merely
   * carries a status, is logged with the request id and becomes a 500 with no
   * internals.
   * @param {unknown} err
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  function handleError(err, req, res, next) {
    if (res.headersSent) {
      next(err);
      return;
    }
    const exposed =
      typeof err === 'object' && err !== null && 'expose' in err && err.expose === true;
    const status = (exposed && statusOf(err)) || 500;
    if (status >= 400 && status < 500) {
      req.log.warn({ err }, 'request rejected');
      sendError(res, status, 'bad_request', http.STATUS_CODES[status] ?? 'Bad request');
      return;
    }
    req.log.error({ err }, 'request failed');
    sendError(res, 500, 'internal', 'Internal server error');
  }
  app.use(handleError);

  return app;
}
