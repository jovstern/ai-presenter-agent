import { useEffect, useRef, useState } from 'react';

/** @import { TranscriptEntry } from './transcript.js' */

// The card's transcript (spec Screens): the coalesced turns transcript.js
// keeps (at most MAX_ENTRIES), user turns set apart, inside a polite live
// region (docs/code-review-notes.md L2, L5).
//
// What a screen reader hears. Live streams a turn a few words at a time, so
// the region is built for additions only: `aria-relevant="additions"` with
// `aria-atomic="false"` announces each added node by itself, and every
// fragment is a node of its own (fragments are append-only, transcript.js),
// so a new turn reads "Presenter: Hello", then " there!", then " How can I
// help?" — the turn once, as it arrives — rather than the growing sentence
// re-read on every fragment, or (atomic) the whole list. An entry dropping
// out of the kept list is a removal, which isn't announced. The hidden
// "Presenter:" / "You:" prefix names the speaker, which the visual style
// (italic, muted for the user) can't. The region stays in the page while
// empty, since one added together with its first content isn't announced.
//
// Layout (docs/metrics/m07.md, miss 1): a box that grew with its text moved
// the bottom-anchored card's top edge on every wrapped line, a layout shift
// each time. So while a session runs, or once there is something to show,
// the box has a fixed height (--transcript-height) and the card resizes once,
// on the press that starts the session. Inside it the list flows top-down
// and the box follows the newest line by scrolling, which moves nothing on
// the page. Content shorter than the box is drawn at its bottom, next to the
// controls, by a translate, not by layout: bottom-aligned in layout, every
// new line would move the ones above it, a layout shift (0.024 at 390 px);
// a transform change isn't one. A viewer who scrolls up to read is left there, and following
// resumes once they scroll back to the bottom. The edges a line is cut at
// fade out (styles.css), and the box is a Tab stop only when it overflows,
// since only then is there anything for the keyboard to scroll.

// How close to the bottom counts as at it: scroll positions can be fractional.
const BOTTOM_SLACK_PX = 4;

/** @param {HTMLElement} box */
function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK_PX;
}

/** @param {HTMLElement} box Marks the edges where a line is cut off. */
function markEdges(box) {
  box.toggleAttribute('data-fade-top', box.scrollTop > 0);
  box.toggleAttribute('data-fade-bottom', !atBottom(box));
}

/** @type {Record<TranscriptEntry['role'], string>} */
const SPEAKER = { agent: 'Presenter', user: 'You' };

/**
 * @param {{ entries: TranscriptEntry[], reserve: boolean }} props
 *   `reserve` is true while a session is starting or running: the box keeps
 *   its height even before the first line.
 */
export function Transcript({ entries, reserve }) {
  const boxRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const contentRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [overflows, setOverflows] = useState(false);
  const hasEntries = entries.length > 0;
  const reserved = reserve || hasEntries;

  // Syncs the scroll position with the list's size, a layout fact React
  // doesn't see: a ResizeObserver runs after layout and before paint, so the
  // newest line is in view in the frame it appears in. The box is observed
  // too, for a change of the card's width or of the reserved height.
  useEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    // Without ResizeObserver (very old browsers, jsdom) the box just doesn't follow: it still scrolls by hand.
    if (!box || !content || typeof ResizeObserver === 'undefined') return;
    let following = true;
    // The position this effect last scrolled to: the scroll event that
    // follows is its own, not the viewer's, even if more text has arrived
    // by the time it fires.
    let ownTop = -1;

    const sync = () => {
      // The content's real height, rounded up: offsetHeight rounds, so a
      // 191.4 px list read as 191 left a 1 px gap whose translate pushed it
      // past the box by a fraction of a pixel, an overflow with nothing cut
      // off (a stray Tab stop and a faded top edge).
      const height = Math.ceil(content.getBoundingClientRect().height);
      const gap = Math.max(0, box.clientHeight - height);
      content.style.translate = gap ? `0 ${gap}px` : '';
      if (following) {
        box.scrollTop = box.scrollHeight;
        ownTop = box.scrollTop;
      }
      markEdges(box);
      setOverflows(box.scrollHeight > box.clientHeight);
    };
    // Its own position counts once: the next scroll event either is its own
    // (skipped) or the viewer's, and either way the next one is the viewer's,
    // even back at that same position.
    const handleScroll = () => {
      if (box.scrollTop !== ownTop) following = atBottom(box);
      ownTop = -1;
      markEdges(box);
    };

    const observer = new ResizeObserver(sync);
    observer.observe(box);
    observer.observe(content);
    box.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      box.removeEventListener('scroll', handleScroll);
    };
  }, []);

  return (
    <div className="transcript" data-reserved={reserved ? '' : undefined}>
      <div
        ref={boxRef}
        className="transcript__box"
        role={hasEntries ? 'region' : undefined}
        aria-label={hasEntries ? 'Transcript' : undefined}
        tabIndex={hasEntries && overflows ? 0 : undefined}
      >
        <div ref={contentRef}>
          {reserved && !hasEntries && (
            <p className="transcript__placeholder">The conversation appears here.</p>
          )}
          <ol
            className="transcript__list"
            aria-live="polite"
            aria-relevant="additions"
            aria-atomic="false"
          >
            {entries.map((entry) => (
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
      </div>
    </div>
  );
}
