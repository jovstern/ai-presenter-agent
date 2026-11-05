# 0004 — Lock the Live token to the model only

Status: accepted (2026-11-02)

## Context

`/api/live-token` mints a Gemini ephemeral token (`ai.authTokens.create`, `server/geminiMint.js`)
that the page uses to open its Live socket. Until M6 T4 the token carried no
`liveConnectConstraints`: anyone holding it within its 60 s window could open one session on
any Live model with any config. The page that receives it is the one the server just served
(same origin, a per-IP rate limit and a page nonce, code-review-notes H1), so a token is
readable by any script on that page.

code-review-notes M7 asked: constrain the model only, or lock the token to an exact mirror of
the client's config?

What `@google/genai` 2.32.0 and Gemini actually do (verified with real mints, M6 T4):
- `liveConnectConstraints` set and `lockAdditionalFields` **left out** locks *every*
  `LiveConnectConfig` field to the token's own config. The client's `tools`,
  `systemInstruction` and `sessionResumption` handle are silently ignored: in a live run the
  agent answered "I cannot perform actions like clicking buttons" and never called a tool.
- `lockAdditionalFields: []` locks only the fields the constraints set. With
  `{ model }` alone, the model is locked and the client's config is used as sent.
- A resumed session doesn't count as a token use, and `expireTime` (default 30 min after the
  mint) bounds how long a session on the token can send messages.

## Options

1. **Model only** (`liveConnectConstraints: { model }`, `lockAdditionalFields: []`). One string
   shared with the client; the client keeps owning its config.
2. **Exact mirror** of the client's config, generated from one object for both. Locks the
   system instruction and tools too, so a stolen token couldn't repurpose the session. The
   tool declarations, the system instruction and the route enum would have to live where
   the server can read them, and every change to them would change the token.
3. **No constraints** (the state before).

## Decision

Option 1. The model name lives in `agent-client/src/liveModel.json`; `liveSession.js` imports
it for `live.connect`, and `server/geminiMint.js` imports it for the constraint, so they can't
drift (the same pattern as `target-app/routes.json`). `uses: 1` and the 60 s
`newSessionExpireTime` stay; `expireTime` stays at Google's 30 min default.

## Consequences

- A token taken from the page opens at most one session, within 60 s, on `gemini-3.8-live`
  only. It can still carry a config the attacker chooses on that model; the per-IP rate limit
  and the nonce (H1) remain what bounds the spend. Option 2 would close that gap at the cost
  of coupling the server to the client's prompt and tools; revisit it if the demo is ever
  embedded on a page whose other scripts aren't trusted.
- Removing `lockAdditionalFields: []` breaks the agent silently (no error, no tools). The
  comment in `server/geminiMint.js` says so, and `server/__tests__/geminiMint.test.js` fails.
- Changing the model is one edit to `liveModel.json`, and a server restart.
- Gemini may close a session at its token's `expireTime`; the client's reconnect mints a fresh
  token and resumes, the same path as the 15-minute audio cap.
