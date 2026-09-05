/**
 * The entire backend for this build. It has exactly one job: mint a short-lived, single-use
 * Gemini Live ephemeral token so the real API key never reaches the browser. Everything else
 * (audio, transcript, tool calls) goes directly from the browser to Gemini Live.
 *
 * See docs/sandbox-simulation.md §6 for why this is the right amount of backend, not a
 * simplification that's cutting a corner.
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { GoogleGenAI } from "@google/genai";

const PORT = process.env.PORT || 8787;
// Confirmed current/recommended against ai.google.dev/gemini-api/docs/models (Sept 2026) — the
// successor to gemini-2.5-flash-native-audio-preview. Re-check that page if this ever needs
// bumping; Google ships new Live models fairly often.
const LIVE_MODEL = "gemini-3.1-flash-live-preview";

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[server] GEMINI_API_KEY is not set — /api/live-token will fail. Copy .env.example to .env and fill it in."
  );
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const app = new Hono();

app.get("/", (c) => c.redirect("/sandbox/"));

// One-time, single-use, short-lived token. The client passes this to `ai.live.connect` in place
// of the real API key. `newSessionExpireTime` bounds how long the client has to *open* the
// session; `expireTime` bounds how long that session can stay open once opened.
app.get("/api/live-token", async (c) => {
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(Date.now() + 60 * 1000), // 1 min to connect
        expireTime: new Date(Date.now() + 30 * 60 * 1000), // 30 min session ceiling
        // Mirrors what the client actually sends to ai.live.connect (see useLiveAgent.js).
        // liveConnectConstraints locks the token to a model + config; unclear from docs how
        // strictly the config half is enforced, so this stays in sync defensively rather than
        // risk the client's real connect config being rejected as a mismatch.
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: ["AUDIO"],
            sessionResumption: {},
          },
        },
      },
    });
    return c.json({ token: token.name, model: LIVE_MODEL });
  } catch (err) {
    console.error("[server] failed to mint ephemeral token:", err);
    return c.json({ error: "failed to mint live token" }, 500);
  }
});

app.use(
  "/target-app/*",
  serveStatic({ root: "../target-app", rewriteRequestPath: (p) => p.replace(/^\/target-app/, "") })
);
app.use(
  "/sandbox/*",
  serveStatic({ root: "../sandbox", rewriteRequestPath: (p) => p.replace(/^\/sandbox/, "") })
);
app.use(
  "/agent-client/*",
  serveStatic({
    root: "../agent-client/dist",
    rewriteRequestPath: (p) => p.replace(/^\/agent-client/, ""),
  })
);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Presenter Agent server on http://localhost:${info.port}`);
  console.log(`Open http://localhost:${info.port}/sandbox/`);
});
