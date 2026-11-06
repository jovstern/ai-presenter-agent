import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Transcript } from '../Transcript.jsx';
import { appendFragment, endTurn } from '../transcript.js';

/** @import { TranscriptEntry } from '../transcript.js' */

// The card's transcript: the last 3 coalesced turns in a polite live region
// that announces only what is new. The merge rules are transcript.test.js.

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

/** @param {TranscriptEntry[]} entries */
function renderTranscript(entries) {
  const utils = render(<Transcript entries={entries} />);
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

  it('renders the last 3 entries, oldest first', () => {
    const entries = build([
      ['agent', 'One.'],
      ['user', 'Two.'],
      ['agent', 'Three.'],
      ['user', 'Four.'],
    ]);
    const { live } = renderTranscript(entries);
    expect(shown(live)).toEqual(['Two.', 'Three.', 'Four.']);
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

  it('is a named, keyboard-focusable region once it has entries (it may scroll)', () => {
    renderTranscript(build([['agent', 'Hello.']]));
    const region = screen.getByRole('region', { name: 'Transcript' });
    expect(region.tabIndex).toBe(0);
    expect(region.contains(screen.getByRole('list'))).toBe(true);
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

  it('keeps the surviving entries as the same nodes when the oldest drops out of view', () => {
    const three = build([
      ['agent', 'One.'],
      ['user', 'Two.'],
      ['agent', 'Three.'],
    ]);
    const { live, rerender } = renderTranscript(three);
    const [, two, threeLine] = live.querySelectorAll('li');

    rerender(<Transcript entries={build([['user', 'Four.']], three)} />);

    const after = live.querySelectorAll('li');
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(two);
    expect(after[1]).toBe(threeLine);
    expect(shown(live)).toEqual(['Two.', 'Three.', 'Four.']);
  });
});
