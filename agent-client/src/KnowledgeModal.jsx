import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { addFile, listFiles, removeFile, totalBytes, MAX_TOTAL_BYTES } from "./knowledgeStore.js";

/**
 * The RAG-lite knowledge UI: drag files in, they land in localStorage, useLiveAgent.js pastes
 * them into the session as context. `container` must be an element inside the shadow root —
 * Radix's Dialog.Portal defaults to document.body, which would escape our style isolation.
 */
export default function KnowledgeModal({ onNotify, container }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(() => listFiles());
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    function onChanged() {
      setFiles(listFiles());
    }
    window.addEventListener("ds-knowledge-changed", onChanged);
    return () => window.removeEventListener("ds-knowledge-changed", onChanged);
  }, []);

  const handleFiles = useCallback(
    async (fileList) => {
      for (const file of Array.from(fileList)) {
        const result = await addFile(file);
        onNotify?.(result.ok ? `Added "${file.name}"` : result.reason);
      }
    },
    [onNotify]
  );

  const usedKb = Math.round(totalBytes(files) / 1024);
  const capMb = Math.round(MAX_TOTAL_BYTES / 1024 / 1024);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="ds-knowledge-trigger" title="Teach the agent about your site">
          📄 {files.length}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="ds-dialog-overlay" />
        <Dialog.Content className="ds-dialog-content">
          <Dialog.Title className="ds-dialog-title">Agent knowledge</Dialog.Title>
          <Dialog.Description className="ds-dialog-description">
            Drop .txt or .md files describing your company or site — stored only in this browser
            ({usedKb}KB / {capMb}MB used), never sent anywhere except straight into this
            conversation as context.
          </Dialog.Description>

          <div
            className={`ds-dropzone${dragOver ? " ds-dropzone--active" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            Drag files here, or click to browse
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md"
              multiple
              hidden
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <ul className="ds-file-list">
            {files.length === 0 && <li className="ds-file-empty">No files yet.</li>}
            {files.map((f) => (
              <li key={f.id} className="ds-file-row">
                <span className="ds-file-name">{f.name}</span>
                <span className="ds-file-size">{Math.round(f.size / 1024)}KB</span>
                <button
                  className="ds-file-remove"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => {
                    removeFile(f.id);
                    onNotify?.(`Removed "${f.name}"`);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <Dialog.Close asChild>
            <button className="ds-dialog-close">Done</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
