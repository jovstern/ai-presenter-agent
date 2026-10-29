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
 * @property {Partial<typeof DEFAULT_LIMITS>} [limits]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DEFAULT_LIMITS = {
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  // 1 hour: long enough for a real demo session (see the H1 note below).
  nonceTtlMs: 60 * 60_000,
  // Caps for the two in-memory maps (deferred from M4: both grew without
  // limit). Far above what one small instance sees in an hour; past them the
  // oldest entry goes, so a flood costs a stale page a reload, not memory.
  maxNonces: 10_000,
  maxClients: 10_000,
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

/** @param {AppOptions} options */
export function createApp({ mintToken, now = Date.now, logger, production = false, limits }) {
  const { rateLimitMax, rateLimitWindowMs, nonceTtlMs, maxNonces, maxClients } = {
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
  // Fixed window per IP: the entry's TTL is the window, and a hit inside it
  // mutates the count without restarting it. req.ip is undefined only for a
  // socket that's already gone; such requests share one bucket.
  /** @type {import('./expiringMap.js').ExpiringMap<{ count: number }>} */
  const requestLog = createExpiringMap({ ttlMs: rateLimitWindowMs, maxSize: maxClients, now });

  /** @param {Request} req */
  function isRateLimited(req) {
    const key = req.ip ?? '';
    const entry = requestLog.get(key);
    if (!entry) {
      requestLog.set(key, { count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > rateLimitMax;
  }

  // A1 (assessment): every URL that renders the sandbox page must go through
  // the nonce template, or the page ships the literal %%DS_NONCE%% and every
  // /api/live-token call fails (see H1 above). Read once: the file only
  // changes on a deploy, which restarts the process anyway.
  const sandboxHtml = fs.readFileSync(path.join(ROOT, 'sandbox/index.html'), 'utf8');

  const app = express();
  app.disable('x-powered-by');

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
    if (!isSameOrigin(req)) {
      sendError(res, 403, 'cross_origin', 'Cross-origin requests are not allowed');
      return;
    }
    if (isRateLimited(req)) {
      sendError(res, 429, 'rate_limited', 'Too many requests');
      return;
    }
    const query = TokenQuery.safeParse(req.query);
    if (!query.success) {
      sendError(res, 400, 'invalid_request', 'The nonce query parameter is missing or malformed');
      return;
    }
    if (!nonces.get(query.data.nonce)) {
      sendError(res, 403, 'invalid_nonce', 'Unknown or expired nonce');
      return;
    }
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

  /**
   * Express 5 routing is non-strict, so '/sandbox' matches both '/sandbox' and
   * '/sandbox/'; the page's asset URLs are absolute, so no redirect is needed.
   * Registered before the /sandbox static mount so it never serves the
   * untemplated file.
   * @param {Request} req
   * @param {Response} res
   */
  function sendSandbox(req, res) {
    const nonce = crypto.randomUUID();
    nonces.set(nonce, true);
    res.type('html').send(sandboxHtml.replace('%%DS_NONCE%%', nonce));
  }

  app.get(['/', '/sandbox', '/sandbox/index.html'], sendSandbox);
  app.use('/agent-client', express.static(path.join(ROOT, 'agent-client/dist')));
  app.use('/sandbox', express.static(path.join(ROOT, 'sandbox')));
  app.use('/target-app', express.static(path.join(ROOT, 'target-app')));

  app.use((req, res) => {
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
