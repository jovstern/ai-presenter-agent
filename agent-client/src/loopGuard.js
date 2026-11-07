// Catches the model going in circles (docs/code-review-notes.md M6), in what it
// does and in what it says. This module only detects; liveSession.js decides
// what a trip does: a tripped action is not dispatched and is answered with a
// failure telling the model to try something else; a tripped utterance gets
// one corrective context turn. liveSession calls reset() on every manual
// connect(), so a new conversation starts clean, userSpoke() on the user's
// own transcription and agentActed() on every tool call.

/** @import { SnapshotNode } from './bridgeProtocol.js' */

// --- Actions ---
// A signature is the action (tool name + normalised args) plus a fingerprint
// of the page it was taken on: liveSession's latest full snapshot, which in a
// batch is the one the previous call's settled snapshot left (bridge.js posts
// it before that call's result), and after a connect or resume the keyframe it
// asks for. Since #25 every response shows the model the page, so the same
// click that moves it on (the counter at 0, 1, 2, …) is progress, not a loop:
// "increment the counter to 10" used to be refused on the 4th click. The same
// action on the same page is what repeats. With no snapshot yet there is no
// fingerprint, and the signature is the bare action.
// Each rule trips on the call that completes `repeats` back-to-back copies of
// a `period`-long pattern. Blocked calls stay in the history, so a model that
// carries on with the same cycle keeps being refused.
// - Period 1 (the same call on the same page): 4th in a row. A click that
//   changes nothing, or a failing one (no snapshot, the page as it was).
// - Period 2 (A-B-A-B): on the second B. The model bouncing between two pages
//   or two buttons twice is the classic agent loop, and it returns to the
//   same two states, so it still trips (a toggle flipped on, off, on, off);
//   home → settings → home once (A-B-A) still passes.
// - Period 3 (A-B-C-A-B-C): on the second C. A three-step routine (fill,
//   toggle, save) is one task; doing it all again, unchanged, is a loop.
// A cycle needs at least two different calls; a constant run is period 1's.
// The window covers one request: the user speaking clears it, since a loop is
// the model acting with no new input. Four separate "click increment"
// requests, or home → settings asked for twice, are no loop.
// A known gap: the agent's own voice picked up by the mic (speakers, no
// headset) comes back as user transcription, so its echo clears the window
// too, and a loop narrated aloud could reset itself. Gating userSpoke() on
// the fragment's length was weighed and not done (M7 T4), on the live e2e's
// transcripts (.metrics/live.json, the 14 scenario runs that recorded one):
// no user line in them echoes the agent, and the one short user turn
// ("notifications and save", 3 words) was a real request the voice detection
// had split off, which a gate would have taken for an echo. userSpoke() also
// runs per fragment, a word or two at a time, so a length gate would need the
// whole turn first. The evidence is thin: the e2e's mic is a file, which can't
// hear the speakers. The browser's echo cancellation (on by default in
// getUserMedia) is the mitigation; an echo seen in a real session reopens it.
// Kept as they are in M6 T5: in 14 live runs with the `ds:loop-trip` mark
// (and 5 more where a refused action would show as a failed tool) nothing
// tripped, and the six-step task's longest repeat is the counter's two
// clicks (docs/metrics/m06.md).
// A known limit of the fingerprint: a page with an element that changes on
// its own (a clock, a live feed) makes every state new, so a no-op loop there
// never repeats a signature. The target app has none. ACTION_BUDGET is the
// backstop: one request gets 50 actions, then each further one is refused
// with a stop-and-ask (not "repeated"), until the user speaks. The six-step
// task takes 6; 50 still lets "increment the counter to 50" finish, and with
// the bridge's settle (100 ms quiet, 1 s cap per action) it bounds a runaway
// to about a minute of acting, plus the model's own turns.
const REPEAT_LIMIT = 3;
export const ACTION_BUDGET = 50;
const CYCLE_RULES = [
  { period: 1, repeats: REPEAT_LIMIT + 1 },
  { period: 2, repeats: 2 },
  { period: 3, repeats: 2 },
];
const ACTION_WINDOW = Math.max(...CYCLE_RULES.map(({ period, repeats }) => period * repeats));

// --- Utterances ---
// An agent turn is all its output-transcription fragments up to the server's
// turnComplete (liveSession accumulates them). It trips when the same
// normalised sentence makes up UTTERANCE_REPEATS of the last UTTERANCE_WINDOW
// turns: three is past a natural "as I said", and a window rather than a run
// catches a loop with other lines interleaved.
// Turns under MIN_UTTERANCE_WORDS words ("Done.", "Okay.") are ignored: a
// multi-step task acknowledges each step that way, and a short repeat costs
// little even when it is a loop.
// A tool call ends the episode too: narrating each step of one request
// ("Clicking the increment button now." before every click) is the model
// working, not talking in circles, and an action that really repeats is the
// action rules' to catch. So only turns with no tool call between them count
// towards a repeat.
const UTTERANCE_WINDOW = 5;
const UTTERANCE_REPEATS = 3;
const MIN_UTTERANCE_WORDS = 4;

/**
 * Lowercase, punctuation dropped, whitespace collapsed.
 * @param {string} text
 */
export function normaliseUtterance(text) {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string[]} history
 * @param {number} period
 * @param {number} repeats
 */
function endsInCycle(history, period, repeats) {
  const length = period * repeats;
  if (history.length < length) return false;
  const tail = history.slice(-length);
  const pattern = tail.slice(0, period);
  if (period > 1 && pattern.every((signature) => signature === pattern[0])) return false;
  return tail.every((signature, i) => signature === pattern[i % period]);
}

export function createLoopGuard() {
  /** @type {string[]} */
  let actions = [];
  let actionsSpent = 0;
  /** @type {string[]} */
  let utterances = [];
  // Whether an utterance trip may fire; false from a trip until the episode ends.
  let armed = true;

  // Returns true when `signature` repeats or completes a cycle past the limits.
  /** @param {string} signature */
  function check(signature) {
    actions.push(signature);
    if (actions.length > ACTION_WINDOW) actions.shift();
    return CYCLE_RULES.some(({ period, repeats }) => endsInCycle(actions, period, repeats));
  }

  // Counts one action against the request's budget; true once it is spent.
  function spendAction() {
    actionsSpent += 1;
    return actionsSpent > ACTION_BUDGET;
  }

  // Returns true once per loop episode: on the turn that makes the sentence a
  // loop, then not again until a turn that isn't one (or the user speaking)
  // ends the episode — so the corrective turn isn't sent on every repeat.
  /** @param {string} text One complete agent turn's transcription. */
  function checkUtterance(text) {
    const normalised = normaliseUtterance(text);
    if (normalised.split(' ').length < MIN_UTTERANCE_WORDS) return false;
    utterances.push(normalised);
    if (utterances.length > UTTERANCE_WINDOW) utterances.shift();
    const looping =
      utterances.filter((utterance) => utterance === normalised).length >= UTTERANCE_REPEATS;
    if (!looping) {
      armed = true;
      return false;
    }
    if (!armed) return false;
    armed = false;
    return true;
  }

  // The agent acting ends any utterance episode: its turns either side of a
  // tool call are steps of a task, not a repeat.
  function agentActed() {
    utterances = [];
    armed = true;
  }

  // The user taking the floor starts a new request: what the agent said or
  // did before no longer counts towards a loop.
  function userSpoke() {
    actions = [];
    actionsSpent = 0;
    agentActed();
  }

  function reset() {
    userSpoke();
  }

  return { check, spendAction, checkUtterance, agentActed, userSpoke, reset };
}

/**
 * The tool name plus its args with keys sorted and strings trimmed, so the
 * same call written two ways is one signature, plus the page it was taken on.
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {string} [page] pageFingerprint() of the page before the action;
 *   none (no snapshot yet) leaves the bare action.
 */
export function actionSignature(name, args, page) {
  const normalised = Object.fromEntries(
    Object.entries(args ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
  );
  const action = `${name}:${JSON.stringify(normalised)}`;
  return page === undefined ? action : `${action}@${page}`;
}

/**
 * A short, stable stand-in for a page state: 32-bit FNV-1a over the full node
 * list's JSON (bridge.js builds every node with the same key order), in base
 * 36. A collision would only merge two states for the guard.
 * @param {SnapshotNode[]} nodes
 */
export function pageFingerprint(nodes) {
  const text = JSON.stringify(nodes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
