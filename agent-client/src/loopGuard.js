/**
 * v1 saw the agent repeat an action or sentence several times in a row with no way out. This
 * guard blocks a dispatch outright once the same signature has repeated back-to-back past the
 * threshold, instead of trying to prompt the behavior away.
 */
const HISTORY_LIMIT = 6;
const REPEAT_THRESHOLD = 3;

export function createLoopGuard({ historyLimit = HISTORY_LIMIT, repeatThreshold = REPEAT_THRESHOLD } = {}) {
  let history = [];

  return {
    /** Records `signature` and returns true if it has now repeated consecutively past the threshold. */
    check(signature) {
      history.push(signature);
      if (history.length > historyLimit) history.shift();
      if (history.length < repeatThreshold) return false;
      const tail = history.slice(-repeatThreshold);
      return tail.every((s) => s === signature);
    },
    reset() {
      history = [];
    },
  };
}
