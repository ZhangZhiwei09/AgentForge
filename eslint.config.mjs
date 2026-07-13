// ESLint flat config for AgentForge monorepo
//
// 安装依赖后生效:
//   pnpm add -D eslint @eslint/js typescript-eslint -w
//
// 规则：
//   - no-explicit-any: warn          (允许临时使用但需注释原因)
//   - no-empty-function: error       (禁止空 catch/callback)
//   - no-unused-vars: error          (禁止未使用变量)
//   - no-console: warn               (生产代码避免 console)
//
// 使用：
//   pnpm lint         → eslint .
//   pnpm typecheck    → tsc --noEmit
//   pnpm format       → prettier --write
//   pnpm format:check → prettier --check

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.claude/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // General
      "no-console": "warn",
      "prefer-const": "error",
      "no-debugger": "error",
    },
  },
  {
    // Test files: allow any and console in tests
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
  {
    // Config/scripts: allow console
    files: ["**/scripts/**/*.{js,ts,mjs}", "*.config.{js,ts,mjs}"],
    rules: {
      "no-console": "off",
    },
  },
);
