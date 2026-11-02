import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Les tests d'intégration partagent la même base : un fichier à la fois.
    fileParallelism: false,
    setupFiles: ["./src/test/setup.ts"],
  },
});
