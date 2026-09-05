/**
 * Client-side "knowledge" storage for the agent — no backend, no indexing pipeline. Text/markdown
 * files the user drops in are read in the browser and kept in localStorage, then dumped straight
 * into the Live session as context (see useLiveAgent.js's sendKnowledgeContext).
 *
 * This is deliberately NOT real RAG: no chunking, no embeddings, no retrieval — just "store some
 * text, paste it into context at connect time." Call it that honestly if asked; see
 * docs/project-knowledge-handoff.md §5.1 for the real-RAG version this would need to become.
 */

const STORAGE_KEY = "ds-agent-knowledge-files";
// localStorage caps out around 5-10MB per origin depending on the browser. This cap stays
// comfortably under that so this feature never eats the whole budget for whatever else this
// origin might store.
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = [".txt", ".md"];

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("[knowledgeStore] failed to read localStorage", err);
    return [];
  }
}

function writeAll(files) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch (err) {
    console.warn("[knowledgeStore] failed to write localStorage", err);
  }
  window.dispatchEvent(new CustomEvent("ds-knowledge-changed"));
}

export function listFiles() {
  return readAll();
}

export function totalBytes(files = readAll()) {
  return files.reduce((sum, f) => sum + f.size, 0);
}

export function isAcceptedFile(file) {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

// FileReader over File.prototype.text() — supported everywhere (including older browsers, and
// notably jsdom's File polyfill in tests, which doesn't implement .text()).
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Reads `file`, validates it, and stores it. Returns {ok:true, entry} or {ok:false, reason}. */
export async function addFile(file) {
  if (!isAcceptedFile(file)) {
    return { ok: false, reason: `"${file.name}" isn't a .txt or .md file` };
  }

  const text = await readFileAsText(file);
  const size = new Blob([text]).size;
  const existing = readAll();

  if (totalBytes(existing) + size > MAX_TOTAL_BYTES) {
    const capMb = Math.round(MAX_TOTAL_BYTES / 1024 / 1024);
    return { ok: false, reason: `adding "${file.name}" would exceed the ${capMb}MB storage limit` };
  }

  const entry = { id: crypto.randomUUID(), name: file.name, size, addedAt: Date.now(), text };
  writeAll([...existing, entry]);
  return { ok: true, entry };
}

export function removeFile(id) {
  writeAll(readAll().filter((f) => f.id !== id));
}

/** Flattens stored files into one context blob for the Live session. Empty string if none. */
export function buildContextText(files = readAll()) {
  if (files.length === 0) return "";
  return files.map((f) => `--- ${f.name} ---\n${f.text}`).join("\n\n");
}
