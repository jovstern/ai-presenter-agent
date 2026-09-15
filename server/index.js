/**
 * The entire backend for this build. It has exactly one job: mint a short-lived, single-use
 * Gemini Live ephemeral token so the real API key never reaches the browser. Everything else
 * (audio, transcript, tool calls) goes directly from the browser to Gemini Live.
 *
 * See docs/sandbox-simulation.md §6 for why this is the right amount of backend, not a
 * simplification that's cutting a corner.
 */
import "dotenv/config";
import express from "express";
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
const app = express();

app.get("/", (req, res) => res.redirect("/sandbox/"));

// One-time, single-use, short-lived token. The client passes this to `ai.live.connect` in place
// of the real API key. `newSessionExpireTime` bounds how long the client has to *open* the
// session; `expireTime` bounds how long that session can stay open once opened.
app.get("/api/live-token", async (req, res) => {
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
    res.json({ token: token.name, model: LIVE_MODEL });
  } catch (err) {
    console.error("[server] failed to mint ephemeral token:", err);
    res.status(500).json({ error: "failed to mint live token" });
  }
});

app.use("/target-app", express.static("../target-app"));
app.use("/sandbox", express.static("../sandbox"));
app.use("/agent-client", express.static("../agent-client/dist"));

app.listen(PORT, () => {
  console.log(`Presenter Agent server on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/sandbox/`);
});
