import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist/ui"
  },
  test: {
    environment: "happy-dom"
  }
});
