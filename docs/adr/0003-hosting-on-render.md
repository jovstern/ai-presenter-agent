# 0003 — Host on Render

Status: accepted (2026-10-28)

## Context

The demo needs:
- HTTPS, because `getUserMedia` and `crypto.randomUUID` require a secure context;
- a Node process for the token endpoint;
- the Gemini key as a secret.

The Express server already serves all the static bundles.

## Options

1. **Render web service.** Auto HTTPS, secrets in the dashboard, PR preview environments, a
   free tier with ~30 s cold starts.
2. **Google Cloud Run.** Same vendor as Gemini, scales to zero; needs a Dockerfile, a GCP
   project and billing.
3. **Fly.io.** Always-on small VM; needs a Dockerfile and a card; no built-in previews.

## Decision

Render, chosen by the user, deployed from a `render.yaml` blueprint. The build step builds
`agent-client` and then starts `server`.

## Consequences

- `GEMINI_API_KEY` lives only in Render's environment; the user sets it in the dashboard.
- `app.set('trust proxy', 1)` is needed so rate limiting sees the client IP and the origin
  check sees `https`.
- Free-tier cold starts add latency to the first visit. It is noted in the README, and the
  metrics only cover warm requests.
