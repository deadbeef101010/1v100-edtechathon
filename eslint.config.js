import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".playwright-browsers/", "dist/", "node_modules/", "static/vendor/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["static/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/**/*.ts", "test/emitter-lint-*/**/*.ts"],
    ignores: ["src/emitter.ts", "**/src/emitter.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='emit']",
          message: "Route outbound application packets through src/emitter.ts",
        },
      ],
    },
  },
);
