// bridge.js always computes a full node list *and* a diff (changed/removed)
// against its last snapshot — cheap, same-process, regardless of page size.
// The decision that actually costs tokens — whether to tell the *model* the
// whole page or just what changed — is made here: a full keyframe on
// navigation, when nothing's been sent yet, or when the delta covers most of
// the page anyway; a compact delta otherwise. Same tradeoff a video codec
// makes between keyframes and delta frames.
/** @import { Snapshot, SnapshotNode } from './bridgeProtocol.js' */

/**
 * What to tell the model about one snapshot.
 * @typedef {{ type: 'keyframe', nodes: SnapshotNode[] }
 *   | { type: 'delta', changed: SnapshotNode[], removed: string[] }} SnapshotDecision
 */

const FULL_REFRESH_RATIO = 0.6;

export function createDomSnapshotContext() {
  let hasSentAny = false;
  let forceKeyframe = false;

  // Call when the page navigates (a fresh document has nothing in common
  // with whatever delta state the last one left behind).
  function markNavigated() {
    forceKeyframe = true;
  }

  /**
   * @param {Snapshot} snapshot As broadcast by bridge.js.
   * @returns {SnapshotDecision}
   */
  function decide({ full, changed, removed }) {
    const totalDelta = changed.length + removed.length;
    const deltaCoversMost = full.length > 0 && totalDelta / full.length >= FULL_REFRESH_RATIO;
    const useKeyframe = !hasSentAny || forceKeyframe || deltaCoversMost;

    hasSentAny = true;
    forceKeyframe = false;

    return useKeyframe ? { type: 'keyframe', nodes: full } : { type: 'delta', changed, removed };
  }

  return { decide, markNavigated };
}

/** @param {SnapshotDecision} decision */
export function formatSnapshotMessage(decision) {
  if (decision.type === 'keyframe') {
    return `Page snapshot (full):\n${JSON.stringify(decision.nodes)}`;
  }
  return `Page snapshot (delta) — changed:\n${JSON.stringify(decision.changed)}\nremoved:\n${JSON.stringify(decision.removed)}`;
}

export { FULL_REFRESH_RATIO };
