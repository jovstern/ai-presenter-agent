import { useId, useRef, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as knowledgeStore from './knowledgeStore.js';
import { focusedIn, tabStops } from './shadowFocus.js';

/** @import { ChangeEvent, DragEvent, KeyboardEvent, MouseEvent } from 'react' */
/** @import { KnowledgeFile } from './knowledgeStore.js' */

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

// The counter's colour band (styles.css): a warning near the limit, the
// danger colour over it; none until then. The words are the polite region's
// and the alert's, so colour is never the only signal.
/** @param {number} length */
function counterLimit(length) {
  const left = MAX_RULES - length;
  if (left < 0) return 'over';
  if (left <= NEAR_LIMIT) return 'near';
  return undefined;
}

// A page with a folded corner and two lines of text: 16 px, in the button's
// text colour, hidden from assistive technology (the button's text names it).
function DocumentIcon() {
  return (
    <svg
      className="agent-app__knowledge-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9.25 1.75h-5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" />
      <path d="M9.25 1.75v3.5h3.5M5.75 8.5h4.5M5.75 11h4.5" />
    </svg>
  );
}

// The over-limit alert appears under the rules field, which on a short phone
// is below the fold while the viewer types, so it is scrolled into view once,
// when it appears (a stable ref callback runs on mount only), not on every
// keystroke after.
/** @param {HTMLElement | null} node */
function scrollIntoViewOnMount(node) {
  node?.scrollIntoView({ block: 'nearest' });
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
  // Why the browser refused to save the rules (not the length: that's `over`).
  const [rulesError, setRulesError] = useState(/** @type {string | null} */ (null));
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const addButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const ids = useId();
  const hintId = `${ids}-hint`;
  const counterId = `${ids}-counter`;
  const rulesErrorId = `${ids}-rules-error`;
  const rulesSaveErrorId = `${ids}-rules-save-error`;

  const rules = unsavedRules ?? storedRules;
  const over = rules.length - MAX_RULES;

  // Stops at the first file the store refuses, and says which and why. An
  // error the store didn't expect is still said, in general words, rather than
  // left as an unhandled rejection with nothing on screen.
  /** @param {File[]} picked */
  async function addFiles(picked) {
    setFileError(null);
    for (const file of picked) {
      let reason;
      try {
        const result = await knowledgeStore.addFile(file);
        if (result.ok) continue;
        reason = result.reason;
      } catch {
        reason = 'Something went wrong; try again';
      }
      setFileError(`${file.name} wasn't added. ${reason}.`);
      break;
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
  // dialog. A removal the browser refused leaves the file, and focus, where
  // they are, and says why.
  /**
   * @param {MouseEvent<HTMLButtonElement>} event
   * @param {KnowledgeFile} file
   */
  function handleRemove(event, file) {
    const item = event.currentTarget.closest('li');
    const neighbour = item?.nextElementSibling ?? item?.previousElementSibling;
    const next = neighbour?.querySelector('button') ?? addButtonRef.current;
    const result = knowledgeStore.removeFile(file.id);
    if (!result.ok) {
      setFileError(`${file.name} wasn't removed. ${result.reason}.`);
      return;
    }
    setFileError(null);
    next?.focus();
  }

  /** @param {ChangeEvent<HTMLTextAreaElement>} event */
  function handleRulesChange(event) {
    const text = event.target.value;
    const result = knowledgeStore.setRules(text);
    // Refused, the text stays in the field, unsaved: over the limit (the
    // alert below says by how much), or because the browser won't save it.
    setUnsavedRules(result.ok ? null : text);
    setRulesError(result.ok || text.length > MAX_RULES ? null : result.reason);
  }

  // An add's error belongs to that visit: opened again, the dialog starts clean.
  /** @param {boolean} nextOpen */
  function handleOpenChange(nextOpen) {
    if (nextOpen) setFileError(null);
    onOpenChange(nextOpen);
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
    // No stops at all can't happen with this markup, but a wrap must not throw.
    (event.shiftKey ? last : first)?.focus();
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      {/* Named by its content, not an aria-label: the visible count has to be
          part of the accessible name (WCAG 2.5.3, axe label-content-name-mismatch),
          and the icon is decoration. The name reads "Knowledge files: 0"; the
          title says the same to a pointer. */}
      <Dialog.Trigger
        className={`agent-app__knowledge-btn${hasContent ? '' : ' agent-app__knowledge-btn--empty'}`}
        title="Knowledge files"
      >
        <DocumentIcon /> <span className="visually-hidden">Knowledge files:</span> {files.length}
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
            The presenter reads these files and rules at the start of every session. They&rsquo;re
            saved in this browser only.
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
                  {/* One line, cut with an ellipsis (styles.css); the title
                      shows the whole name to a pointer, and Remove's
                      accessible name carries it to assistive technology. */}
                  <span className="knowledge-modal__file-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="knowledge-modal__file-size">{formatSize(file.size)}</span>
                  <button
                    type="button"
                    className="knowledge-modal__remove"
                    onClick={(event) => handleRemove(event, file)}
                  >
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
            aria-describedby={[
              hintId,
              counterId,
              over > 0 && rulesErrorId,
              rulesError && rulesSaveErrorId,
            ]
              .filter(Boolean)
              .join(' ')}
          />
          <p
            id={counterId}
            className="knowledge-modal__counter"
            data-limit={counterLimit(rules.length)}
          >
            {formatCount(rules.length)} / {formatCount(MAX_RULES)}
          </p>
          <p className="visually-hidden" role="status">
            {rulesNotice(rules.length)}
          </p>
          {rulesError && (
            <p id={rulesSaveErrorId} className="knowledge-modal__error" role="alert">
              {rulesError}. They stay in the field but won&rsquo;t survive a reload.
            </p>
          )}
          {over > 0 && (
            <p
              id={rulesErrorId}
              className="knowledge-modal__error"
              role="alert"
              ref={scrollIntoViewOnMount}
            >
              Rules are {formatCount(over)} {over === 1 ? 'character' : 'characters'} over the limit
              and aren&rsquo;t saved. Shorten them to save.
            </p>
          )}

          {/* Sticky at the dialog's bottom edge, so Close is in reach however
              long the list or the rules get, on the shortest phone. */}
          <div className="knowledge-modal__footer">
            <Dialog.Close>Close</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
