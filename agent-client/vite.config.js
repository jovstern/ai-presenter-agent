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
    lib: {
      entry: 'src/main.jsx',
      name: 'AgentClient',
      formats: ['iife'],
      fileName: () => 'agent-client.js',
    },
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
  },
});
