import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds to a single self-contained script — the same "prebuilt bundle inserted as a script
// tag" shape the real system used, and the reason a shadow root + manually-injected <style>
// are used instead of a separate CSS file (see src/main.jsx).
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
  ],
  build: {
    outDir: "dist",
    cssCodeSplit: false,
    emptyOutDir: true,
    lib: {
      entry: "src/main.jsx",
      name: "DsAgentClient",
      formats: ["iife"],
      fileName: () => "agent-client.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
