import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode === "panel") {
    return {
      base: "./",
      root: fileURLToPath(new URL("./src/ui/", import.meta.url)),
      build: {
        outDir: fileURLToPath(new URL("./dist/ui/", import.meta.url)),
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          output: {
            assetFileNames: "assets/[name]-[hash][extname]",
            entryFileNames: "assets/[name]-[hash].js",
            hashCharacters: "hex",
          },
        },
      },
    };
  }

  return {
    root: packageRoot,
    build: {
      outDir: "dist",
      emptyOutDir: false,
      ssr: "src/index.ts",
      rollupOptions: {
        external: [/^node:/, /^openclaw\//],
        output: { entryFileNames: "index.js" },
      },
    },
    test: {
      environment: "happy-dom",
      fileParallelism: false,
    },
  };
});
