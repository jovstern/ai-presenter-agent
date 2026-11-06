import { useId, useRef, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as knowledgeStore from './knowledgeStore.js';
import { focusedIn, tabStops } from './shadowFocus.js';

/** @import { ChangeEvent, DragEvent, KeyboardEvent, MouseEvent } from 'react' */

const MAX_RULES = knowledgeStore.MAX_RULES_CHARS;
// Within this many characters of the limit, the polite region says so, once.
const NEAR_LIMIT = MAX_RULES / 10;

/** @param {number} n */
const formatCount = (n) => n.toLocaleString('en-US');

/** @param {number} bytes */
const formatSize = (bytes) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

// What the polite region says about the rules' length. It changes only when
// the length crosses into another band, so a screen reader hears it once on
// the way to the limit, not on every keystroke. Over the limit is the alert's.
/** @param {number} length */
function rulesNotice(length) {
  const left = MAX_RULES - length;
  if (left === 0) return `At the ${formatCount(MAX_RULES)}-character limit.`;
  if (left > 0 && left <= NEAR_LIMIT) return `${formatCount(NEAR_LIMIT)} or fewer characters left.`;
  return '';
}

/**
 * The knowledge button and its dialog (spec Screens, R21): files and standing
 * rules, read from and written to knowledgeStore.js. The store is the one
 * source of truth, read through useSyncExternalStore; the only state here is
 * what the store doesn't hold (an add's error, the drag highlight, and rules
 * the store refused for being over the limit, kept so nothing typed is lost).
 *
 * Focus, in the widget's shadow root: Radix's FocusScope finds focus with
 * document.activeElement, which there is the shadow host, never the focused
 * control. So its Tab wrap never matched the first or last control and Tab
 * walked out of the dialog (to Radix's focus guards on the page, then the
 * browser), and its open autofocus never saw focus move and fell back to the
 * dialog itself. The Content's onKeyDown below does the wrap with the shadow
 * root's own active element, and onOpenAutoFocus focuses Add files. Closing
 * returns focus to the knowledge button because it is the Dialog.Trigger:
 * there was no trigger before, so Radix had nowhere to return focus to.
 *
 * Controlled: the card owns `open`, since it makes itself inert while the
 * dialog is open (AgentApp.jsx).
 *
 * @param {{
 *   portalContainer: HTMLElement | undefined,
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 * }} props
 *   `portalContainer` keeps the dialog in the shadow root (main.jsx).
 */
export function KnowledgeModal({ portalContainer, open, onOpenChange }) {
  const files = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.listFiles);
  const storedRules = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getRules);
  const hasContent = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.hasContent);
  const [unsavedRules, setUnsavedRules] = useState(/** @type {string | null} */ (null));
  const [fileError, setFileError] = useState(/** @type {string | null} */ (null));
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const addButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const ids = useId();
  const hintId = `${ids}-hint`;
  const counterId = `${ids}-counter`;
  const rulesErrorId = `${ids}-rules-error`;

  const rules = unsavedRules ?? storedRules;
  const over = rules.length - MAX_RULES;

  // Stops at the first file the store refuses, and says which and why.
  /** @param {File[]} picked */
  async function addFiles(picked) {
    setFileError(null);
    for (const file of picked) {
      const result = await knowledgeStore.addFile(file);
      if (!result.ok) {
        setFileError(`${file.name} wasn't added. ${result.reason}.`);
        break;
      }
    }
  }

  /** @param {ChangeEvent<HTMLInputElement>} event */
  function handlePicked(event) {
    const picked = [...(event.target.files ?? [])];
    // Cleared, so picking the same file again (after removing it) is a change.
    event.target.value = '';
    addFiles(picked);
  }

  /** @param {DragEvent<HTMLButtonElement>} event */
  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    addFiles([...event.dataTransfer.files]);
  }

  // The removed button takes focus with it, so focus moves to the next file's
  // Remove button, else the previous one's, else Add files: never out of the
  // dialog.
  /**
   * @param {MouseEvent<HTMLButtonElement>} event
   * @param {string} id
   */
  function handleRemove(event, id) {
    const item = event.currentTarget.closest('li');
    const neighbour = item?.nextElementSibling ?? item?.previousElementSibling;
    const next = neighbour?.querySelector('button') ?? addButtonRef.current;
    knowledgeStore.removeFile(id);
    next?.focus();
  }

  /** @param {ChangeEvent<HTMLTextAreaElement>} event */
  function handleRulesChange(event) {
    const text = event.target.value;
    setUnsavedRules(knowledgeStore.setRules(text).ok ? null : text);
  }

  // The focus trap's Tab wrap, at the dialog's two edges; between them the
  // browser's own Tab order applies, and it stays inside the dialog.
  /** @param {KeyboardEvent<HTMLDivElement>} event */
  function handleKeyDown(event) {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const content = event.currentTarget;
    const stops = tabStops(content);
    const active = focusedIn(content);
    const first = stops[0];
    const last = stops[stops.length - 1];
    // Shift+Tab from the dialog itself (focused when it can't focus a
    // control) counts as from the first control.
    const atEdge = event.shiftKey ? active === first || active === content : active === last;
    if (!atEdge) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* Named by its content, not an aria-label: the visible count has to be
          part of the accessible name (WCAG 2.5.3, axe label-content-name-mismatch),
          and the emoji is decoration. The name reads "Knowledge files: 0". */}
      <Dialog.Trigger
        className={`agent-app__knowledge-btn${hasContent ? '' : ' agent-app__knowledge-btn--empty'}`}
      >
        <span aria-hidden="true">📄</span> <span className="visually-hidden">Knowledge files:</span>{' '}
        {files.length}
      </Dialog.Trigger>
      <Dialog.Portal container={portalContainer}>
        <Dialog.Overlay className="knowledge-modal__overlay" />
        <Dialog.Content
          className="knowledge-modal__content"
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            addButtonRef.current?.focus();
          }}
        >
          <Dialog.Title>Knowledge</Dialog.Title>
          <Dialog.Description>
            Files and standing rules the presenter is given as context in every session. Not real
            RAG: no chunking or retrieval, the content is sent to the model whole.
          </Dialog.Description>

          {/* A real button, so the keyboard reaches the file picker; files
              dropped on it are added too. */}
          <button
            ref={addButtonRef}
            type="button"
            className="knowledge-modal__dropzone"
            data-dragging={isDragging ? 'true' : undefined}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <span className="knowledge-modal__dropzone-action">Add files</span>{' '}
            <span className="knowledge-modal__dropzone-hint">or drop .txt and .md files here</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={knowledgeStore.ACCEPTED_EXTENSIONS.join(',')}
            multiple
            hidden
            onChange={handlePicked}
          />

          {fileError && (
            <p className="knowledge-modal__error" role="alert">
              {fileError}
            </p>
          )}

          {files.length === 0 ? (
            <p className="knowledge-modal__empty">
              No files yet. Add product notes or a script, and the presenter draws on them when it
              talks.
            </p>
          ) : (
            <ul className="knowledge-modal__files" aria-label="Files">
              {files.map((file) => (
                <li key={file.id}>
                  <span className="knowledge-modal__file-name">{file.name}</span>
                  <span className="knowledge-modal__file-size">{formatSize(file.size)}</span>
                  <button type="button" onClick={(event) => handleRemove(event, file.id)}>
                    Remove <span className="visually-hidden">{file.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="knowledge-modal__rules-label" htmlFor={`${ids}-rules`}>
            Rules
          </label>
          <p id={hintId} className="knowledge-modal__hint">
            Standing instructions, for example &ldquo;always speak in French&rdquo;.
          </p>
          <textarea
            id={`${ids}-rules`}
            className="knowledge-modal__rules"
            value={rules}
            onChange={handleRulesChange}
            aria-invalid={over > 0 ? true : undefined}
            aria-describedby={[hintId, counterId, over > 0 && rulesErrorId]
              .filter(Boolean)
              .join(' ')}
          />
          <p
            id={counterId}
            className="knowledge-modal__counter"
            data-over={over > 0 ? 'true' : undefined}
          >
            {formatCount(rules.length)} / {formatCount(MAX_RULES)}
          </p>
          <p className="visually-hidden" role="status">
            {rulesNotice(rules.length)}
          </p>
          {over > 0 && (
            <p id={rulesErrorId} className="knowledge-modal__error" role="alert">
              Rules are {formatCount(over)} characters over the limit and aren&rsquo;t saved.
              Shorten them to save.
            </p>
          )}

          <Dialog.Close className="knowledge-modal__close">Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
