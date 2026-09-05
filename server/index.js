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
const LIVE_MODEL = "gemini-3.1-flash-live-preview"; // check ai.google.dev/gemini-api/docs/live-api for the current model id

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
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: { responseModalities: ["AUDIO"] },
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
