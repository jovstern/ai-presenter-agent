import { afterEach, describe, expect, it, vi } from 'vitest';
import { tabStops } from '../shadowFocus.js';

// The Tab stops a focus wrap goes to (KnowledgeModal.jsx): only what a Tab
// press can land on, so never a control that isn't rendered.

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** @param {string} html */
function container(html) {
  const node = document.createElement('div');
  node.innerHTML = html;
  document.body.append(node);
  return node;
}

describe('tabStops', () => {
  it('lists focusable controls in document order, without disabled or tabindex -1 ones', () => {
    const node = container(`
      <button id="a">A</button>
      <button id="b" disabled>B</button>
      <div id="c" tabindex="0">C</div>
      <span id="d" tabindex="-1">D</span>
      <textarea id="e"></textarea>`);
    expect(tabStops(node).map((stop) => stop.id)).toEqual(['a', 'c', 'e']);
  });

  it('skips a control inside a hidden subtree', () => {
    const node = container(`
      <button id="a">A</button>
      <div hidden><button id="b">B</button></div>
      <input id="c" type="file" hidden />`);
    expect(tabStops(node).map((stop) => stop.id)).toEqual(['a']);
  });

  it('asks the browser whether a control is rendered, where it can (display: none from a stylesheet, say)', () => {
    const node = container(`<button id="a">A</button><button id="b">B</button>`);
    const b = /** @type {HTMLElement} */ (node.querySelector('#b'));
    Object.defineProperty(b, 'checkVisibility', { value: () => false });
    expect(tabStops(node).map((stop) => stop.id)).toEqual(['a']);
  });

  it('returns no stops for a container with nothing focusable', () => {
    expect(tabStops(container('<p>Text only</p>'))).toEqual([]);
  });
});
