import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as knowledgeStore from './knowledgeStore.js';

export function KnowledgeModal({ open, onOpenChange, portalContainer }) {
  const [files, setFiles] = useState(() => knowledgeStore.listFiles());
  const [rules, setRulesState] = useState(() => knowledgeStore.getRules());
  const [error, setError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  async function handleFiles(fileList) {
    setError(null);
    for (const file of fileList) {
      const result = await knowledgeStore.addFile(file);
      if (!result.ok) {
        setError(result.reason);
        break;
      }
    }
    setFiles(knowledgeStore.listFiles());
  }

  function handleRemove(id) {
    knowledgeStore.removeFile(id);
    setFiles(knowledgeStore.listFiles());
  }

  function handleRulesChange(e) {
    const text = e.target.value;
    setRulesState(text);
    const result = knowledgeStore.setRules(text);
    setError(result.ok ? null : result.reason);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={portalContainer}>
        <Dialog.Overlay className="knowledge-modal__overlay" />
        <Dialog.Content className="knowledge-modal__content">
          <Dialog.Title>Knowledge</Dialog.Title>
          <Dialog.Description>
            Files and standing rules given to the agent as context. Not real RAG — no chunking or
            retrieval, the content is sent to the model directly.
          </Dialog.Description>

          <div
            className={`knowledge-modal__dropzone${isDragging ? ' knowledge-modal__dropzone--active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            Drag .txt/.md files here, or click to browse
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md"
              multiple
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>

          {error && <div className="knowledge-modal__error">{error}</div>}

          <ul className="knowledge-modal__files">
            {files.map((f) => (
              <li key={f.id}>
                {f.name} ({Math.round(f.size / 1024)}KB)
                <button onClick={() => handleRemove(f.id)}>Remove</button>
              </li>
            ))}
          </ul>

          <label className="knowledge-modal__rules-label">
            Rules (standing instructions, e.g. "always speak in French")
            <textarea
              className="knowledge-modal__rules"
              value={rules}
              onChange={handleRulesChange}
              maxLength={knowledgeStore.MAX_RULES_CHARS}
            />
          </label>

          <Dialog.Close asChild>
            <button className="knowledge-modal__close">Close</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
