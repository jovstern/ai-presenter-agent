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

function readFiles() {
  try {
    return JSON.parse(localStorage.getItem(FILES_KEY)) ?? [];
  } catch {
    return [];
  }
}

function writeFiles(files) {
  localStorage.setItem(FILES_KEY, JSON.stringify(files));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function hasAcceptedExtension(name) {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function listFiles() {
  return readFiles();
}

export function totalBytes() {
  return readFiles().reduce((sum, f) => sum + f.size, 0);
}

// Resolves { ok: true, file } or { ok: false, reason }. Refuses outright on
// a rejected extension or an over-cap size — no silent failure, no truncation.
export async function addFile(file) {
  if (!hasAcceptedExtension(file.name)) {
    return { ok: false, reason: `Only ${ACCEPTED_EXTENSIONS.join('/')} files are accepted` };
  }
  const files = readFiles();
  const currentTotal = files.reduce((sum, f) => sum + f.size, 0);
  if (currentTotal + file.size > MAX_TOTAL_BYTES) {
    return { ok: false, reason: `Adding this file would exceed the ${MAX_TOTAL_BYTES / (1024 * 1024)}MB total limit` };
  }

  const text = await file.text();
  const entry = { id: crypto.randomUUID(), name: file.name, size: file.size, addedAt: Date.now(), text };
  writeFiles([...files, entry]);
  return { ok: true, file: entry };
}

export function removeFile(id) {
  writeFiles(readFiles().filter((f) => f.id !== id));
}

export function getRules() {
  return localStorage.getItem(RULES_KEY) ?? '';
}

// Resolves { ok: true } or { ok: false, reason }.
export function setRules(text) {
  if (text.length > MAX_RULES_CHARS) {
    return { ok: false, reason: `Rules must be ${MAX_RULES_CHARS} characters or fewer` };
  }
  localStorage.setItem(RULES_KEY, text);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return { ok: true };
}

export function hasContent() {
  return readFiles().length > 0 || getRules().trim().length > 0;
}

// The context-stuffing blob sent into the live session: rules framed and
// ordered ahead of file context so the model treats them as higher priority.
export function buildContextMessage() {
  const rules = getRules().trim();
  const filesText = readFiles()
    .map((f) => f.text)
    .join('\n\n');

  const parts = [];
  if (rules) parts.push(`STRICT RULES (must always follow):\n${rules}`);
  if (filesText) parts.push(`Knowledge context:\n${filesText}`);
  return parts.join('\n\n');
}

export { CHANGE_EVENT, MAX_TOTAL_BYTES, MAX_RULES_CHARS, ACCEPTED_EXTENSIONS };
