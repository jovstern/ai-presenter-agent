// bridge.js always computes a full node list *and* a diff (changed/removed)
// against its last snapshot — cheap, same-process, regardless of page size.
// The decision that actually costs tokens — whether to tell the *model* the
// whole page or just what changed — is made here: a full keyframe on
// navigation, when nothing's been sent yet, or when the delta covers most of
// the page anyway; a compact delta otherwise. Same tradeoff a video codec
// makes between keyframes and delta frames.
/** @import { Snapshot, SnapshotNode } from './bridgeProtocol.js' */

/**
 * What to tell the model about one snapshot. A keyframe's `omitted` is the
 * bridge's count of elements left out on a page over its cap (0 otherwise).
 * @typedef {{ type: 'keyframe', nodes: SnapshotNode[], omitted: number }
 *   | { type: 'delta', changed: SnapshotNode[], removed: string[] }} SnapshotDecision
 */

// Kept at 0.6 in M6 T5 and M9 T6: a delta that covers 60 % of the nodes costs
// about as much as the keyframe that also resets the model's view. On the
// Orders page (issue #22) a tick, a ship or a fill changes 1–3 of 30 nodes
// (0.03–0.1), and ticking then shipping five rows 6 (0.2); only a scroll goes
// past it (docs/metrics/README.md).
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
  function decide({ full, changed, removed, omitted = 0 }) {
    const totalDelta = changed.length + removed.length;
    const deltaCoversMost = full.length > 0 && totalDelta / full.length >= FULL_REFRESH_RATIO;
    // On a page over the bridge's cap, a node leaves the snapshot when a
    // scroll moves it away, not only when the page drops it: a delta's
    // `removed` would tell the model it is gone. A keyframe says what is in
    // view, and that more exists.
    const scrolledOut = omitted > 0 && removed.length > 0;
    const useKeyframe = !hasSentAny || forceKeyframe || deltaCoversMost || scrolledOut;

    hasSentAny = true;
    forceKeyframe = false;

    return useKeyframe
      ? { type: 'keyframe', nodes: full, omitted }
      : { type: 'delta', changed, removed };
  }

  return { decide, markNavigated };
}

/** @param {SnapshotDecision} decision */
export function formatSnapshotMessage(decision) {
  if (decision.type === 'keyframe') {
    const snapshot = `Page snapshot (full):\n${JSON.stringify(decision.nodes)}`;
    if (decision.omitted === 0) return snapshot;
    return `${snapshot}\nThe page has ${decision.omitted} more elements not listed: off screen or hidden. To reach one off screen, scroll to the listed element nearest it (the first or the last), then look again.`;
  }
  return `Page snapshot (delta) — changed:\n${JSON.stringify(decision.changed)}\nremoved:\n${JSON.stringify(decision.removed)}`;
}

export { FULL_REFRESH_RATIO };
