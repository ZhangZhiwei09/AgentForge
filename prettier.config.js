/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  trailingComma: "all",
  printWidth: 100,
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
  overrides: [
    {
      files: ["*.json", "*.yaml", "*.yml"],
      options: { tabWidth: 2 },
    },
    {
      files: ["*.md"],
      options: { proseWrap: "preserve" },
    },
  ],
};
