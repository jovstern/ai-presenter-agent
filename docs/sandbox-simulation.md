# Simulating the sandbox + iframe world (without a cloning engine)

The real Demostack system clones an arbitrary target web app and serves the clone same-origin with
the sandbox that wraps it — that's what let the sandbox operate on the iframe's DOM directly. This
doc explains how this build fakes that world simply, and why "just point the iframe at any real
website" doesn't actually work.

## 1. Why you can't just iframe an arbitrary real site

Two independent browser mechanisms block it:

- **Framing itself can be refused.** Most real sites send `X-Frame-Options: DENY`/`SAMEORIGIN` or a
  CSP `frame-ancestors` directive specifically to stop being iframed. Try it on almost any major
  site and the iframe simply won't load — that's not a bug in your sandbox, it's the target
  choosing not to be embedded.
- **Even when framing is allowed, cross-origin content is DOM-opaque.** If the iframe's origin
  differs from the sandbox's, the same-origin policy blocks the parent from reading or mutating
  anything inside it — no `contentDocument`, no `querySelector`, nothing. This is exactly the
  boundary the real system avoided by making sure the clone and the sandbox shared an origin.

So "any real site" and "skip building a cloning engine" are in tension: the only way to legally
manipulate a real, arbitrary site's DOM from outside is to serve a same-origin copy of it — which
*is* the cloning engine, just under a different name.

## 2. What this build does instead

A tiny **target-app**: two or three static pages you author yourself, served from the same origin
as the sandbox (same dev server, a different route). It has a handful of interactive elements —
a nav link, a button, a form field — each carrying a `data-testid` attribute so the agent has a
stable, meaningful thing to target. That's it. No crawler, no network capture, no persistence
layer. It's not a simplification that loses the point of the exercise — it *is* the same trust
model the real system relied on (same-origin clone + sandbard operating on it directly), just with
"clone" replaced by "author a couple of pages by hand."

This is genuinely worth knowing on its own, independent of this project: **when you need to embed
something and act on it programmatically, same-origin-with-a-thing-you-control beats
cross-origin-with-a-thing-you-don't**, almost every time. It's the same reason browser extensions
use content scripts injected into the page they're allowed to touch, rather than trying to reach
in from outside.

## 3. Readiness detection gets simpler here (and why)

The original system used a `postMessage`-based "ready" handshake, because the real cloned app
could be a client-side-routed SPA — no full page navigation between "pages," so no native browser
load event to hook. This build's target-app is a handful of *plain* static pages linked with real
`<a href>` navigation, which means the iframe fires a genuine `load` event on every page change.
So the bridge just listens to `iframe.addEventListener('load', ...)` directly — simpler and more
reliable than a one-shot message, and correct specifically because the target isn't an SPA.

If you ever swap the target-app for something SPA-like, bring back the announce-on-navigate
pattern: the target posts a message on every client-side route change, and the bridge checks
current state first, then subscribes — the same check-then-listen shape the original system used
to avoid missing a message that fired before the listener was attached.

## 4. Only one postMessage hop, not two

Because the iframe is same-origin with the sandbox, the sandbox's bridge script can read and
mutate the iframe's DOM **directly** (`iframe.contentDocument.querySelector(...)`, etc.) — it does
not need to relay a second `postMessage` across the iframe boundary to do so. The one hop that
matters is between the **agent-client** (mounted in a shadow root, its own deployable bundle) and
the **sandbox's own bridge script** — two independently-built pieces of code sharing one `window`,
talking via `window.postMessage` by choice, not by cross-origin necessity. Keep that distinction
clear when explaining this out loud: same-origin doesn't mean "no postMessage," it means "no
postMessage *required* — you're choosing it for decoupling, and you still have to secure it like
you mean it" (origin + token + allowlist, per the rebuild spec's goal #1–#3).

## 5. If you ever want a real external site (deferred, not built here)

The minimal way to actually point this at an arbitrary real site later: a thin same-origin
**reverse proxy** — the server fetches the target's HTML/assets, rewrites absolute URLs to route
back through the proxy, and serves the result from your own origin so the iframe is same-origin
again. That's not a hack; it's a tiny, honest slice of what the real Demostack cloning engine does
at much larger scale (network capture, asset rewriting, persistence). Worth naming explicitly if
asked "so this doesn't actually work on a real site?" — the honest answer is "not without rebuilding
the one piece we deliberately scoped out," not "yes it does."

## 6. Do you need a backend at all?

Only for one job: minting a short-lived, single-use **ephemeral token** for Gemini Live, so the
real API key never reaches the browser. Everything else — audio streaming, transcript, the model
deciding to click/navigate — goes directly from the browser to Gemini Live once it has that token.
This mirrors the original system's own `token` + `sessionId` pattern almost exactly; it's not new
complexity, it's the same shape scoped down to its one essential purpose.
