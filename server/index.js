import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SANDBOX_HTML_PATH = path.join(__dirname, '../sandbox/index.html');

const app = express();

// Fix for docs/code-review-notes.md H1 (open token vending machine): gate on
// same-origin, rate-limit per IP, and require a nonce that sandbox/index.html
// embeds at serve time and the client echoes back. This closes the
// cross-origin-frame/other-window vector. It does NOT close the co-resident-
// script vector H1 also describes — a hostile script already running on this
// origin can read window.__DS_NONCE__ off the page just like agent-client
// does. What the nonce actually buys: a request must come from a script that
// loaded on *this* page, not an arbitrary cross-origin/cross-frame caller.
//
// Deliberately NOT single-use, despite H1's original wording: a live Gemini
// token is itself single-use + 60s (below), so a real conversation fetches a
// fresh one on every connect *and* every reconnect (network drop, session-
// cap resumption). A single-use nonce made every reconnect after the first
// fail with a 403 — caught by testing B2's reconnect path, not a theoretical
// concern. Reusable within a generous TTL instead; a page open longer than
// that needs a reload, which is an acceptable bar for this project's scope.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map(); // ip -> { count, windowStart }

const NONCE_TTL_MS = 60 * 60_000; // 1 hour — long enough for a real demo session
const nonces = new Map(); // nonce -> expiresAt

function issueNonce() {
  const now = Date.now();
  for (const [key, expiresAt] of nonces) {
    if (expiresAt < now) nonces.delete(key);
  }
  const nonce = crypto.randomUUID();
  nonces.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

function isValidNonce(nonce) {
  if (!nonce || !nonces.has(nonce)) return false;
  return Date.now() <= nonces.get(nonce);
}

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

function isRateLimited(req) {
  const now = Date.now();
  const entry = requestLog.get(req.ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    requestLog.set(req.ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

app.get('/api/live-token', async (req, res) => {
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    return;
  }
  if (isRateLimited(req)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  if (!isValidNonce(req.query.nonce)) {
    res.status(403).json({ error: 'Missing, invalid, or expired nonce' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server' });
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    res.json({ token: token.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mint live token', detail: err.message });
  }
});

app.use('/agent-client', express.static(path.join(__dirname, '../agent-client/dist')));
app.use('/sandbox', express.static(path.join(__dirname, '../sandbox')));
app.use('/target-app', express.static(path.join(__dirname, '../target-app')));
app.get('/', (req, res) => {
  const html = fs.readFileSync(SANDBOX_HTML_PATH, 'utf8').replace('%%DS_NONCE%%', issueNonce());
  res.type('html').send(html);
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
