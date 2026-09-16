import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// Partial fix for docs/code-review-notes.md H1 (open token vending machine):
// gate on same-origin and rate-limit per IP. This does NOT close the
// co-resident-script vector H1 describes (a hostile script running on this
// same origin, e.g. inside the sandboxed clone) — that needs a short-TTL nonce
// embedded in the sandbox page and echoed back by the client, which can't be
// wired up until sandbox/ exists (M3/M4). Tracked there.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map(); // ip -> { count, windowStart }

function isSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true; // no Origin header (e.g. direct navigation) — can't verify, allow
  return origin === `${req.protocol}://${req.get('host')}`;
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

// M1 scope note: sandbox/ and target-app/ don't exist yet (that's M3). Serving
// agent-client's build output plus a bare harness page is enough to manually
// verify the voice round trip in a real browser; the harness is replaced by
// sandbox/index.html once M3 lands.
app.use('/agent-client', express.static(path.join(__dirname, '../agent-client/dist')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dev-harness.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
