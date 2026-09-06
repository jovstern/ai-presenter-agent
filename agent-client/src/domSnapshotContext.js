/**
 * Decides what to actually tell the model about a DOM-snapshot update — a full "keyframe" (every
 * element on the page) or a compact "delta frame" (only what changed) — the same tradeoff a video
 * codec makes. bridge.js always computes and sends changed/removed/full together (cheap, same-
 * process postMessage); this module is where the token-cost decision actually lives, since that's
 * the thing that costs anything.
 *
 * A full refresh is warranted when: the page just changed (the old element set is irrelevant, not
 * just stale), there's nothing to diff against yet, or the delta is close to the whole page anyway
 * (a compact message wouldn't be meaningfully cheaper). Otherwise, a delta is strictly less to say.
 */
const FULL_REFRESH_RATIO = 0.6;

export function isFullRefresh({ page, previousPage, changed, removed, full }) {
  if (page !== previousPage) return true;
  if (full.length === 0) return true;
  return (changed.length + removed.length) / full.length >= FULL_REFRESH_RATIO;
}

export function buildFullSnapshotText({ page, full }) {
  if (full.length === 0) return null;
  const summary = full
    .map((n) => `${n.selector} (${n.role}): "${n.label}"${n.disabled ? " [disabled]" : ""}`)
    .join("\n");
  return `[page context, not spoken] Now on "${page}". Elements:\n${summary}`;
}

export function buildIncrementalText({ page, changed, removed }) {
  const lines = [
    ...changed.map((n) => `${n.selector} (${n.role}) is now: "${n.label}"${n.disabled ? " [disabled]" : ""}`),
    ...removed.map((selector) => `${selector} is no longer on the page`),
  ];
  if (lines.length === 0) return null;
  return `[page update, not spoken] On "${page}":\n${lines.join("\n")}`;
}
