// Caps consecutive identical action signatures. This only tracks the repeat
// count; liveSession.js decides what to do past the cap (it skips the dispatch
// and answers the tool call with a failure telling the model to try something
// else), and calls reset() on every manual connect().
const DEFAULT_THRESHOLD = 3;

export function createLoopGuard(threshold = DEFAULT_THRESHOLD) {
  /** @type {string | null} */
  let lastSignature = null;
  let count = 0;

  // Returns true once `signature` has repeated past the threshold.
  /** @param {string} signature */
  function check(signature) {
    if (signature === lastSignature) {
      count += 1;
    } else {
      lastSignature = signature;
      count = 1;
    }
    return count > threshold;
  }

  function reset() {
    lastSignature = null;
    count = 0;
  }

  return { check, reset };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
export function actionSignature(name, args) {
  return `${name}:${JSON.stringify(args ?? {})}`;
}
