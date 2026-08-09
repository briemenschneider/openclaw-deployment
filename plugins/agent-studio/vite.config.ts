import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/ui"
  },
  test: {
    environment: "happy-dom"
  }
});
