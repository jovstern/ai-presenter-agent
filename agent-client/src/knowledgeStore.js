/**
 * One uploaded file, stored whole in localStorage.
 * @typedef {{ id: string, name: string, size: number, addedAt: number, text: string }} KnowledgeFile
 */
/**
 * What addFile and setRules resolve to: no silent failure, no truncation.
 * @template {object} [Extra={}]
 * @typedef {({ ok: true } & Extra) | { ok: false, reason: string }} StoreResult
 */

const FILES_KEY = 'ds-agent-knowledge-files';
const RULES_KEY = 'ds-agent-knowledge-rules';
const CHANGE_EVENT = 'ds-knowledge-changed';

// .txt/.md only, deliberately — avoids pulling in pdf.js/mammoth.js for
// PDF/DOCX parsing. Additive to revisit (ACCEPTED_EXTENSIONS + a parsing
// step in addFile), not a rework, if that's ever requested.
const ACCEPTED_EXTENSIONS = ['.txt', '.md'];

// Comfortably under localStorage's ~5-10MB per-origin ceiling.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

// Rules are meant to be short standing instructions, not a document.
const MAX_RULES_CHARS = 2000;

// A value that fails to parse, or isn't an array, reads as empty: a non-array
// (written by another script on this origin, or by hand) used to reach
// totalBytes' reduce and throw inside useSyncExternalStore.
/** @returns {KnowledgeFile[]} */
function readFiles() {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(FILES_KEY) ?? '[]');
  } catch {
    return [];
  }
  // Only this module writes the entries, so an array is trusted to hold
  // KnowledgeFiles rather than checked field by field.
  return Array.isArray(parsed) ? /** @type {KnowledgeFile[]} */ (parsed) : [];
}

/** @param {KnowledgeFile[]} files */
function writeFiles(files) {
  localStorage.setItem(FILES_KEY, JSON.stringify(files));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** @param {string} name */
function hasAcceptedExtension(name) {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Shared shape for addFile/setRules instead of each hand-rolling { ok, ... }.
/**
 * @template {object} Extra
 * @param {Extra} extra
 * @returns {{ ok: true } & Extra}
 */
function ok(extra) {
  return { ok: true, ...extra };
}
/**
 * @param {string} reason
 * @returns {{ ok: false, reason: string }}
 */
function fail(reason) {
  return { ok: false, reason };
}

export function listFiles() {
  return readFiles();
}

export function totalBytes() {
  return readFiles().reduce((sum, f) => sum + f.size, 0);
}

export function fileCount() {
  return readFiles().length;
}

// Resolves ok({ file }) or fail(reason). Refuses outright on a rejected
// extension or an over-cap size — no silent failure, no truncation.
/**
 * @param {File} file
 * @returns {Promise<StoreResult<{ file: KnowledgeFile }>>}
 */
export async function addFile(file) {
  if (!hasAcceptedExtension(file.name)) {
    return fail(`Only ${ACCEPTED_EXTENSIONS.join('/')} files are accepted`);
  }
  const files = readFiles();
  const currentTotal = files.reduce((sum, f) => sum + f.size, 0);
  if (currentTotal + file.size > MAX_TOTAL_BYTES) {
    return fail(
      `Adding this file would exceed the ${MAX_TOTAL_BYTES / (1024 * 1024)}MB total limit`,
    );
  }

  const text = await file.text();
  const entry = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    addedAt: Date.now(),
    text,
  };
  writeFiles([...files, entry]);
  return ok({ file: entry });
}

/** @param {string} id */
export function removeFile(id) {
  writeFiles(readFiles().filter((f) => f.id !== id));
}

export function getRules() {
  return localStorage.getItem(RULES_KEY) ?? '';
}

// Returns ok({}) or fail(reason).
/**
 * @param {string} text
 * @returns {StoreResult}
 */
export function setRules(text) {
  if (text.length > MAX_RULES_CHARS) {
    return fail(`Rules must be ${MAX_RULES_CHARS} characters or fewer`);
  }
  localStorage.setItem(RULES_KEY, text);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return ok({});
}

export function hasContent() {
  return readFiles().length > 0 || getRules().trim().length > 0;
}

// For useSyncExternalStore: subscribe to every store write, files or rules.
/**
 * @param {() => void} callback
 * @returns {() => void} The unsubscribe function.
 */
export function subscribe(callback) {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

// The context-stuffing blob sent into the live session: rules framed and
// ordered ahead of file context so the model treats them as higher priority.
export function buildContextMessage() {
  const rules = getRules().trim();
  const filesText = readFiles()
    .map((f) => f.text)
    .join('\n\n');

  /** @type {string[]} */
  const parts = [];
  if (rules) parts.push(`STRICT RULES (must always follow):\n${rules}`);
  if (filesText) parts.push(`Knowledge context:\n${filesText}`);
  return parts.join('\n\n');
}

export { CHANGE_EVENT, MAX_TOTAL_BYTES, MAX_RULES_CHARS, ACCEPTED_EXTENSIONS };
