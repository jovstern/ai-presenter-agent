import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { KnowledgeModal } from '../KnowledgeModal.jsx';
import * as knowledgeStore from '../knowledgeStore.js';

// The knowledge button and its dialog (spec Screens, R21), mounted the way
// main.jsx mounts the widget: in an open shadow root, with the dialog portalled
// into a container in that same root. Inside it document.activeElement is the
// shadow host, which is what broke Radix's focus handling (KnowledgeModal.jsx),
// so focus is read from the shadow root here, as a user's browser would see it.

/** @type {HTMLElement} */
let host;
/** @type {ShadowRoot} */
let shadowRoot;

function renderModal() {
  host = document.createElement('div');
  document.body.appendChild(host);
  shadowRoot = host.attachShadow({ mode: 'open' });
  // One wrapper holds both, so queries can be scoped to it (Testing Library
  // takes an element, not a shadow root; screen only searches the light DOM).
  const wrapper = document.createElement('div');
  const mountPoint = document.createElement('div');
  const portalContainer = document.createElement('div');
  wrapper.append(mountPoint, portalContainer);
  shadowRoot.append(wrapper);
  render(<ControlledModal portalContainer={portalContainer} />, { container: mountPoint });
  return within(wrapper);
}

// The dialog is controlled; the card owns `open` (AgentApp.jsx), as this does.
/** @param {{ portalContainer: HTMLElement }} props */
function ControlledModal({ portalContainer }) {
  const [open, setOpen] = useState(false);
  return <KnowledgeModal portalContainer={portalContainer} open={open} onOpenChange={setOpen} />;
}

const focused = () => shadowRoot.activeElement;

/** @param {ReturnType<typeof renderModal>} ui */
async function openDialog(ui) {
  const trigger = ui.getByRole('button', { name: 'Knowledge files: 0' });
  trigger.focus();
  await act(async () => fireEvent.click(trigger));
  return { trigger, dialog: ui.getByRole('dialog', { name: 'Knowledge' }) };
}

/** @param {string} name @param {string | number} content */
function textFile(name, content) {
  return new File([String(content)], name, { type: 'text/plain' });
}

/** @param {File[]} files */
async function pick(files) {
  const input = /** @type {HTMLInputElement} */ (shadowRoot.querySelector('input[type="file"]'));
  await act(async () => fireEvent.change(input, { target: { files } }));
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  host.remove();
  vi.restoreAllMocks();
});

describe('KnowledgeModal', () => {
  it('explains the empty state and offers the next action', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    expect(within(dialog).getByText(/No files yet/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Add files/ })).toBeTruthy();
  });

  it('opens the file picker from a real button, so the keyboard reaches it', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const add = within(dialog).getByRole('button', { name: /Add files/ });
    // A <button>: in the Tab order, and Enter or Space press it.
    expect(add.tagName).toBe('BUTTON');
    expect(add.getAttribute('type')).toBe('button');
    fireEvent.click(add);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('lists an added file, counts it on the button, and removes it by its named button', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    await pick([textFile('notes.md', 'hello')]);

    const list = within(dialog).getByRole('list', { name: 'Files' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['notes.md5 BRemove notes.md']);
    expect(within(dialog).queryByText(/No files yet/)).toBeNull();
    expect(ui.getByRole('button', { name: 'Knowledge files: 1' })).toBeTruthy();

    const remove = within(dialog).getByRole('button', { name: 'Remove notes.md' });
    remove.focus();
    fireEvent.click(remove);
    expect(within(dialog).queryByRole('list', { name: 'Files' })).toBeNull();
    expect(within(dialog).getByText(/No files yet/)).toBeTruthy();
    expect(knowledgeStore.listFiles()).toEqual([]);
    // The removed button's focus goes to Add files, not out of the dialog.
    expect(focused()).toBe(within(dialog).getByRole('button', { name: /Add files/ }));
  });

  it('moves focus to the next Remove button when a file is removed', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    await pick([textFile('a.txt', 'A'), textFile('b.txt', 'B')]);
    const removeA = within(dialog).getByRole('button', { name: 'Remove a.txt' });
    removeA.focus();
    fireEvent.click(removeA);
    expect(focused()).toBe(within(dialog).getByRole('button', { name: 'Remove b.txt' }));
  });

  it('shows an oversize file as an alert, and lists nothing', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    await pick([textFile('huge.txt', 'a'.repeat(knowledgeStore.MAX_TOTAL_BYTES + 1))]);
    expect(within(dialog).getByRole('alert').textContent).toMatch(/exceed the 4MB total limit/);
    expect(within(dialog).queryByRole('list', { name: 'Files' })).toBeNull();
  });

  it('adds files dropped on the drop zone', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    const zone = within(dialog).getByRole('button', { name: /Add files/ });
    await act(async () =>
      fireEvent.drop(zone, { dataTransfer: { files: [textFile('dropped.txt', 'x')] } }),
    );
    expect(within(dialog).getByRole('button', { name: 'Remove dropped.txt' })).toBeTruthy();
  });

  it('counts the rules, described by the counter, and announces only near the limit', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    const rules = within(dialog).getByRole('textbox', { name: /Rules/ });
    const max = knowledgeStore.MAX_RULES_CHARS;

    fireEvent.change(rules, { target: { value: 'Speak French.' } });
    const counter = within(dialog).getByText(`13 / ${max.toLocaleString('en-US')}`);
    expect(rules.getAttribute('aria-describedby')?.split(' ')).toContain(counter.id);
    // The counter isn't live (not every keystroke), and the polite region is quiet.
    expect(counter.closest('[aria-live]')).toBeNull();
    const polite = within(dialog).getByRole('status');
    expect(polite.textContent).toBe('');
    expect(knowledgeStore.getRules()).toBe('Speak French.');

    fireEvent.change(rules, { target: { value: 'a'.repeat(max - 10) } });
    const near = polite.textContent;
    expect(near).toBe('200 or fewer characters left.');
    // Nearer still, the same band: the message doesn't change, so it isn't
    // announced again on each keystroke.
    fireEvent.change(rules, { target: { value: 'a'.repeat(max - 5) } });
    expect(polite.textContent).toBe(near);
    fireEvent.change(rules, { target: { value: 'a'.repeat(max) } });
    expect(polite.textContent).toBe('At the 2,000-character limit.');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('keeps over-limit rules on screen with an alert, unsaved', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    const rules = /** @type {HTMLTextAreaElement} */ (
      within(dialog).getByRole('textbox', { name: /Rules/ })
    );
    const max = knowledgeStore.MAX_RULES_CHARS;
    fireEvent.change(rules, { target: { value: 'Be brief.' } });

    const tooLong = 'a'.repeat(max + 5);
    fireEvent.change(rules, { target: { value: tooLong } });
    // Nothing typed is lost or cut: the text stays, the store keeps the last
    // rules that fit, and the alert says how to fix it.
    expect(rules.value).toBe(tooLong);
    expect(knowledgeStore.getRules()).toBe('Be brief.');
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toMatch(/5 characters over/);
    expect(rules.getAttribute('aria-invalid')).toBe('true');
    expect(rules.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);

    fireEvent.change(rules, { target: { value: 'Be brief, always.' } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(rules.hasAttribute('aria-invalid')).toBe(false);
    expect(knowledgeStore.getRules()).toBe('Be brief, always.');
  });

  it('focuses the first control on open', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    await waitFor(() =>
      expect(focused()).toBe(within(dialog).getByRole('button', { name: /Add files/ })),
    );
  });

  it('wraps Tab from the last control to the first, and Shift+Tab from the first to the last', async () => {
    const ui = renderModal();
    const { dialog } = await openDialog(ui);
    const first = within(dialog).getByRole('button', { name: /Add files/ });
    const last = within(dialog).getByRole('button', { name: 'Close' });

    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); // default prevented
    expect(focused()).toBe(first);

    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(focused()).toBe(last);

    // Between the edges the browser's own Tab order applies, inside the dialog.
    const rules = within(dialog).getByRole('textbox', { name: /Rules/ });
    rules.focus();
    expect(fireEvent.keyDown(rules, { key: 'Tab' })).toBe(true);
  });

  it('closes on Escape and returns focus to the knowledge button', async () => {
    const ui = renderModal();
    const { trigger, dialog } = await openDialog(ui);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const rules = within(dialog).getByRole('textbox', { name: /Rules/ });
    rules.focus();
    await act(async () => fireEvent.keyDown(rules, { key: 'Escape' }));
    expect(ui.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(focused()).toBe(trigger));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
