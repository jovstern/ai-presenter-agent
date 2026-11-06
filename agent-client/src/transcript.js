// The coalesced transcript (spec Screens, docs/code-review-notes.md L5): Live
// streams each turn as transcription fragments, and the card shows turns, not
// fragments. Pure, so the merge and spacing rules are tested on their own
// (transcript.test.js); useLiveAgent.js keeps the list in React state.
//
// Spacing follows what Live sends (the live e2e's transcripts in
// .metrics/live.json): within a turn, each fragment carries its own leading
// space and a word may arrive in pieces, so fragments are joined verbatim.
// Across a turn boundary (turnComplete or interrupted) the next turn's first
// fragment has no leading space — a narrated tool sequence read "a second
// time.I am navigating" — so a turn that continues the same speaker's entry is
// joined with one space.

/** @import { TranscriptFragment } from './liveSession.js' */

/**
 * One speaker's consecutive speech: the fragments are kept as they arrived
 * (append-only), so Transcript.jsx can render each as its own node and the live
 * region announces only what is new.
 * @typedef {object} TranscriptEntry
 * @property {number} id Stable for the entry's life, never reused: a React key.
 * @property {TranscriptFragment['role']} role
 * @property {string[]} fragments
 * @property {boolean} ended The speaker's turn ended; their next fragment
 *   continues this entry after a space.
 */

/** The bound on kept entries; the card shows the last 3 of them. */
export const MAX_ENTRIES = 20;

/**
 * @param {TranscriptEntry[]} list
 * @param {TranscriptFragment} fragment
 * @returns {TranscriptEntry[]} A new list; `list` is unchanged.
 */
export function appendFragment(list, { role, text }) {
  const last = list.at(-1);
  if (last && last.role === role) {
    if (!text) return list;
    const needsSpace = last.ended && !/\s$/.test(entryText(last)) && !/^\s/.test(text);
    const merged = {
      ...last,
      fragments: [...last.fragments, needsSpace ? ` ${text}` : text],
      ended: false,
    };
    return [...list.slice(0, -1), merged];
  }
  const trimmed = text.trimStart();
  if (!trimmed) return list;
  const entry = { id: (last?.id ?? 0) + 1, role, fragments: [trimmed], ended: false };
  return [...list, entry].slice(-MAX_ENTRIES);
}

/**
 * Marks the last entry's turn as ended (Live's turnComplete or interrupted).
 * @param {TranscriptEntry[]} list
 * @returns {TranscriptEntry[]} `list` itself when there is nothing to end.
 */
export function endTurn(list) {
  const last = list.at(-1);
  if (!last || last.ended) return list;
  return [...list.slice(0, -1), { ...last, ended: true }];
}

/** @param {TranscriptEntry} entry */
export function entryText(entry) {
  return entry.fragments.join('');
}
