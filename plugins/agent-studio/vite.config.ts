import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index"
    },
    rollupOptions: {
      external: ["openclaw/plugin-sdk/plugin-entry"]
    }
  },
  test: {
    environment: "happy-dom"
  }
});
