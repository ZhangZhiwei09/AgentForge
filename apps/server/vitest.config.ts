import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: ["--max-old-space-size=512"],
      },
    },
    coverage: {
      provider: "v8",
      include: [
        "src/services/**/*.ts",
        "src/tools/**/*.ts",
        "src/routes/**/*.ts",
      ],
      exclude: ["src/__tests__/**"],
    },
  },
});
