/** @import { TranscriptEntry } from './transcript.js' */

// The card's transcript (spec Screens): the last 3 coalesced turns, user turns
// set apart, inside a polite live region (docs/code-review-notes.md L2, L5).
//
// What a screen reader hears. Live streams a turn a few words at a time, so
// the region is built for additions only: `aria-relevant="additions"` with
// `aria-atomic="false"` announces each added node by itself, and every
// fragment is a node of its own (fragments are append-only, transcript.js),
// so a new turn reads "Presenter: Hello", then " there!", then " How can I
// help?" — the turn once, as it arrives — rather than the growing sentence
// re-read on every fragment, or (atomic) the whole list. An entry scrolling
// out of the last 3 is a removal, which isn't announced. The hidden
// "Presenter:" / "You:" prefix names the speaker, which the visual style
// (italic, muted for the user) can't. The region stays in the page while
// empty, since one added together with its first content isn't announced.
//
// Layout: it sits above the controls, so on the bottom-anchored card a growing
// turn moves the card's top edge, never the buttons under the pointer. Past
// --transcript-max-height it scrolls, pinned to the newest line by
// `column-reverse` (styles.css), and is then a focusable named region so the
// keyboard can scroll it too.

const VISIBLE_ENTRIES = 3;
/** @type {Record<TranscriptEntry['role'], string>} */
const SPEAKER = { agent: 'Presenter', user: 'You' };

/** @param {{ entries: TranscriptEntry[] }} props */
export function Transcript({ entries }) {
  const visible = entries.slice(-VISIBLE_ENTRIES);
  const hasEntries = visible.length > 0;

  return (
    <div
      className="transcript"
      data-empty={hasEntries ? undefined : ''}
      role={hasEntries ? 'region' : undefined}
      aria-label={hasEntries ? 'Transcript' : undefined}
      tabIndex={hasEntries ? 0 : undefined}
    >
      <ol
        className="transcript__list"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        {visible.map((entry) => (
          <li key={entry.id} className="transcript__entry" data-role={entry.role}>
            <span className="visually-hidden">{SPEAKER[entry.role]}: </span>
            <span className="transcript__text">
              {/* Append-only, so the index is a stable key. */}
              {entry.fragments.map((fragment, i) => (
                <span key={i}>{fragment}</span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
