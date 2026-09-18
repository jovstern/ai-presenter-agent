// Caps consecutive identical action signatures. Past the cap, the caller
// should inject a corrective context turn instead of dispatching again —
// this only tracks the repeat count, it doesn't decide what to do about it.
const DEFAULT_THRESHOLD = 3;

export function createLoopGuard(threshold = DEFAULT_THRESHOLD) {
  let lastSignature = null;
  let count = 0;

  // Returns true once `signature` has repeated past the threshold.
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

export function actionSignature(name, args) {
  return `${name}:${JSON.stringify(args ?? {})}`;
}
