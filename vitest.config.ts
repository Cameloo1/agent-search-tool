import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-search/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@agent-search/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)),
      "@agent-search/sources": fileURLToPath(new URL("./packages/sources/src/index.ts", import.meta.url)),
      "@agent-search/embeddings": fileURLToPath(new URL("./packages/embeddings/src/index.ts", import.meta.url)),
      "@agent-search/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@agent-search/eval": fileURLToPath(new URL("./packages/eval/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
