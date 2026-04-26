import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dashboard/dist/**",
      "node_modules/**",
      "memory/**",
      "data/**",
      "mcp-servers/**",
      "src/voice/clankvox/target/**",
      "src/voice/clankvox/build_log.txt",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-unsafe-finally": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAnyKeyword",
          message:
            "Avoid casting to `any`; prefer concrete types and narrowing.",
        },
        {
          selector: "TSAsExpression > TSUnknownKeyword",
          message:
            "Avoid casting to `unknown`; prefer concrete types and narrowing.",
        },
        {
          selector: "TSTypeAssertion > TSAnyKeyword",
          message:
            "Avoid casting to `any`; prefer concrete types and narrowing.",
        },
        {
          selector: "TSTypeAssertion > TSUnknownKeyword",
          message:
            "Avoid casting to `unknown`; prefer concrete types and narrowing.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["dashboard/src/**/*.ts", "dashboard/src/**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
