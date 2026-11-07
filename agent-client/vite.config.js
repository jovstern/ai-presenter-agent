import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // The React Compiler, through Babel: plugin-react 6 compiles JSX with oxc
    // and has no `babel` option of its own (the one this file used to pass was
    // silently ignored — docs/code-review-notes.md M10). The preset is the
    // plugin's documented stable path; it applies to client code, which
    // includes the vitest run below.
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    // An ES module, not an IIFE, so the Gemini SDK can be a chunk of its own,
    // fetched on Talk (src/liveSdk.js, docs/adr/0005-load-the-gemini-sdk-on-talk.md).
    // sandbox/index.html loads it with <script type="module">. An app build
    // with a JS entry rather than lib mode: lib mode never minifies an ES
    // build's whitespace.
    rolldownOptions: {
      input: 'src/main.jsx',
      output: {
        entryFileNames: 'agent-client.js',
        // Hashed: a page loaded before a deploy can't pair its entry with a
        // newer SDK chunk (it gets a 404, which liveSdk.js reports).
        chunkFileNames: '[name]-[hash].js',
      },
    },
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
  },
});
