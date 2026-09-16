import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', {}]],
      },
    }),
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
})
