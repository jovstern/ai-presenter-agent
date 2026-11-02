// Catches the model going in circles (docs/code-review-notes.md M6), in what it
// does and in what it says. This module only detects; liveSession.js decides
// what a trip does: a tripped action is not dispatched and is answered with a
// failure telling the model to try something else; a tripped utterance gets
// one corrective context turn. liveSession calls reset() on every manual
// connect(), so a new conversation starts clean.

// --- Actions ---
// Each rule trips on the call that completes `repeats` back-to-back copies of
// a `period`-long pattern. Blocked calls stay in the history, so a model that
// carries on with the same cycle keeps being refused.
// - Period 1 (the same call over and over): 4th in a row. Three is legitimate
//   ("increment the counter three times"); a fourth unasked one is a loop.
// - Period 2 (A-B-A-B): on the second B. The model bouncing between two pages
//   or two buttons twice is the classic agent loop; home → settings → home
//   once (A-B-A) still passes.
// - Period 3 (A-B-C-A-B-C): on the second C. A three-step routine (fill,
//   toggle, save) is one task; doing it all again, unchanged, is a loop.
// A cycle needs at least two different calls; a constant run is period 1's.
// Kept as they are in M6 T5: in 14 live runs with the `ds:loop-trip` mark
// (and 5 more where a refused action would show as a failed tool) nothing
// tripped, and the six-step task's longest repeat is the counter's two
// clicks (docs/metrics/m06.md).
const REPEAT_LIMIT = 3;
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

  // The user taking the floor ends any utterance episode: what the agent said
  // before no longer counts towards a loop.
  function userSpoke() {
    utterances = [];
    armed = true;
  }

  function reset() {
    actions = [];
    userSpoke();
  }

  return { check, checkUtterance, userSpoke, reset };
}

/**
 * The tool name plus its args with keys sorted and strings trimmed, so the
 * same call written two ways is one signature.
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
export function actionSignature(name, args) {
  const normalised = Object.fromEntries(
    Object.entries(args ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
  );
  return `${name}:${JSON.stringify(normalised)}`;
}
