import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Transcript } from '../Transcript.jsx';
import { appendFragment, endTurn } from '../transcript.js';

/** @import { TranscriptEntry } from '../transcript.js' */

// The card's transcript: the kept coalesced turns in a polite live region
// that announces only what is new, in a fixed box that follows the newest
// line. The merge rules are transcript.test.js.

/**
 * @param {Array<['agent' | 'user', string] | 'end'>} steps
 * @param {TranscriptEntry[]} [start]
 */
function build(steps, start = []) {
  return steps.reduce(
    (list, step) =>
      step === 'end' ? endTurn(list) : appendFragment(list, { role: step[0], text: step[1] }),
    start,
  );
}

/**
 * @param {TranscriptEntry[]} entries
 * @param {boolean} [reserve]
 */
function renderTranscript(entries, reserve = false) {
  const utils = render(<Transcript entries={entries} reserve={reserve} />);
  const live = /** @type {HTMLElement} */ (utils.container.querySelector('[aria-live]'));
  return { live, ...utils };
}

/** The visible text of each rendered entry, without its spoken role prefix. */
const shown = (/** @type {HTMLElement} */ live) =>
  [...live.querySelectorAll('li')].map((li) => li.querySelector('.transcript__text')?.textContent);

afterEach(cleanup);

describe('Transcript', () => {
  it('is a polite live region that announces additions, not the whole list', () => {
    const { live } = renderTranscript(build([['agent', 'Hello.']]));
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-relevant')).toBe('additions');
    expect(live.getAttribute('aria-atomic')).toBe('false');
  });

  it('keeps the live region in the page while empty, with nothing to focus or browse to', () => {
    // A live region has to exist before its first content for screen readers
    // to announce that content.
    const { live, container } = renderTranscript([]);
    expect(live).not.toBeNull();
    expect(live.children).toHaveLength(0);
    expect(screen.queryByRole('region')).toBeNull();
    expect(container.querySelector('[tabindex]')).toBeNull();
  });

  it('renders every kept entry, oldest first (transcript.js bounds the list)', () => {
    const entries = build([
      ['agent', 'One.'],
      ['user', 'Two.'],
      ['agent', 'Three.'],
      ['user', 'Four.'],
    ]);
    const { live } = renderTranscript(entries);
    expect(shown(live)).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
  });

  it('names each speaker for assistive tech and marks the role for styling', () => {
    renderTranscript(
      build([
        ['agent', 'Hi there.'],
        ['user', 'Go to settings.'],
      ]),
    );
    const [agentLine, userLine] = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(agentLine.textContent).toBe('Presenter: Hi there.');
    expect(userLine.textContent).toBe('You: Go to settings.');
    expect(agentLine.querySelector('.visually-hidden')?.textContent).toBe('Presenter: ');
    expect(agentLine.dataset.role).toBe('agent');
    expect(userLine.dataset.role).toBe('user');
  });

  it('is a named region once it has entries', () => {
    renderTranscript(build([['agent', 'Hello.']]));
    const region = screen.getByRole('region', { name: 'Transcript' });
    expect(region.contains(screen.getByRole('list'))).toBe(true);
  });

  it('reserves its box while a session runs or once it has entries, and not idle and empty', () => {
    const { container, rerender } = renderTranscript([]);
    const outer = /** @type {HTMLElement} */ (container.firstElementChild);
    expect(outer.hasAttribute('data-reserved')).toBe(false);
    expect(screen.queryByText('The conversation appears here.')).toBeNull();

    rerender(<Transcript entries={[]} reserve />);
    expect(outer.hasAttribute('data-reserved')).toBe(true);
    // Empty while reserved: a line says what the box is for.
    expect(screen.getByText('The conversation appears here.')).toBeTruthy();

    rerender(<Transcript entries={build([['agent', 'Hi.']])} reserve={false} />);
    expect(outer.hasAttribute('data-reserved')).toBe(true);
    expect(screen.queryByText('The conversation appears here.')).toBeNull();
  });

  it('adds a new node per fragment and keeps the nodes already announced', () => {
    // Only additions are announced (aria-relevant), so a fragment must be a
    // node of its own: rewriting one growing text node would re-read the turn.
    const first = build([['agent', 'Hello']]);
    const { live, rerender } = renderTranscript(first);
    const line = live.querySelector('li');
    const firstFragment = line?.querySelector('.transcript__text')?.firstElementChild;

    rerender(<Transcript entries={build([['agent', ' there!']], first)} />);

    expect(live.querySelector('li')).toBe(line);
    const fragments = line?.querySelector('.transcript__text')?.children;
    expect(fragments).toHaveLength(2);
    expect(fragments?.[0]).toBe(firstFragment);
    expect(fragments?.[0].textContent).toBe('Hello');
    expect(fragments?.[1].textContent).toBe(' there!');
  });

  it('keeps the surviving entries as the same nodes when the oldest drops out', () => {
    const three = build([
      ['agent', 'One.'],
      ['user', 'Two.'],
      ['agent', 'Three.'],
    ]);
    const { live, rerender } = renderTranscript(three);
    const [, two, threeLine] = live.querySelectorAll('li');

    rerender(
      <Transcript entries={[...three.slice(1), ...build([['user', 'Four.']], three).slice(-1)]} />,
    );

    const after = live.querySelectorAll('li');
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(two);
    expect(after[1]).toBe(threeLine);
    expect(shown(live)).toEqual(['Two.', 'Three.', 'Four.']);
  });
});

// jsdom has no layout: the box's scroll metrics are set by hand, and the
// ResizeObserver that reports a size change is a fake the test fires.
describe('Transcript: following the newest line', () => {
  /** @type {Array<() => void>} */
  let resizeCallbacks;

  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        /** @param {() => void} callback */
        constructor(callback) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * A box `clientHeight` tall whose content is `content` tall; scrollTop
   * clamps the way a browser's does.
   * @param {HTMLElement} box
   * @param {number} clientHeight
   */
  function fakeLayout(box, clientHeight) {
    let content = 0;
    let top = 0;
    Object.defineProperty(box, 'clientHeight', { get: () => clientHeight });
    Object.defineProperty(box.firstElementChild, 'offsetHeight', { get: () => content });
    Object.defineProperty(box, 'scrollHeight', { get: () => Math.max(content, clientHeight) });
    Object.defineProperty(box, 'scrollTop', {
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(value, Math.max(content, clientHeight) - clientHeight));
      },
    });
    return {
      /** The list grew (or shrank) to `height`, and the observer reports it (unless `notify` is false). */
      grow(/** @type {number} */ height, notify = true) {
        content = height;
        if (notify) act(() => resizeCallbacks.forEach((callback) => callback()));
      },
      /** The viewer scrolls to `value`. */
      scrollTo(/** @type {number} */ value) {
        box.scrollTop = value;
        fireEvent.scroll(box);
      },
    };
  }

  function setup() {
    renderTranscript(build([['agent', 'A long answer.']]), true);
    const box = screen.getByRole('region', { name: 'Transcript' });
    return { box, ...fakeLayout(box, 192) };
  }

  // By a translate, not layout: a layout change would move the lines above
  // each new one (a layout shift).
  it('draws content shorter than the box at its bottom, next to the controls', () => {
    const { box, grow } = setup();
    const content = /** @type {HTMLElement} */ (box.firstElementChild);
    grow(100);
    expect(content.style.translate).toBe('0 92px');
    grow(150);
    expect(content.style.translate).toBe('0 42px');
    grow(400);
    expect(content.style.translate).toBe('');
  });

  it('is no Tab stop while everything fits, and one once it overflows', () => {
    const { box, grow } = setup();
    grow(100);
    expect(box.hasAttribute('tabindex')).toBe(false);
    grow(400);
    expect(box.tabIndex).toBe(0);
  });

  it('keeps the newest line in view as the list grows, fading only the cut-off top edge', () => {
    const { box, grow } = setup();
    grow(400);
    expect(box.scrollTop).toBe(208);
    expect(box.hasAttribute('data-fade-top')).toBe(true);
    expect(box.hasAttribute('data-fade-bottom')).toBe(false);
    grow(460);
    expect(box.scrollTop).toBe(268);
  });

  it('leaves a viewer who scrolled up where they are, and follows again once they are back at the bottom', () => {
    const { box, grow, scrollTo } = setup();
    grow(400);
    scrollTo(50);
    grow(500);
    expect(box.scrollTop).toBe(50);
    expect(box.hasAttribute('data-fade-top')).toBe(true);
    expect(box.hasAttribute('data-fade-bottom')).toBe(true);

    scrollTo(308); // the bottom
    expect(box.hasAttribute('data-fade-bottom')).toBe(false);
    grow(600);
    expect(box.scrollTop).toBe(408);
  });

  // Its own position counts once: a viewer who scrolls up and back down to
  // the bottom — the same position it last scrolled to — is followed again.
  it('follows again when the viewer returns to the bottom at its own last position', () => {
    const { box, grow, scrollTo } = setup();
    grow(400); // scrolls itself to 208; that scroll's event never came
    scrollTo(50);
    scrollTo(208); // the viewer, back at the bottom
    grow(460);
    expect(box.scrollTop).toBe(268);
  });

  it('treats the scroll event of its own scrolling as its own, even after more text arrived', () => {
    const { box, grow } = setup();
    grow(400); // scrolls itself to 208
    // More text lays out before that scroll's event is delivered: at 208 the
    // box is no longer at the bottom, but the viewer didn't scroll.
    grow(460, false);
    fireEvent.scroll(box);
    grow(520);
    expect(box.scrollTop).toBe(328);
  });
});
