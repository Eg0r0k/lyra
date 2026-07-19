import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },

  // Library source — type-aware linting (covered by ./tsconfig.json).
  {
    files: ["src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // `_`-prefixed args/vars are the repo's "intentionally unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Many async methods exist only to satisfy Promise-returning interfaces
      // (strategy/handler contracts); requiring an inner await is noise here.
      "@typescript-eslint/require-await": "off",
      // A `let` read in a closure defined before its single assignment (e.g.
      // EventEmitter.waitFor's unsubscribe) genuinely needs `let`.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // A static class FIELD WITH AN INITIALIZER lowers (ES2020 target) to a
      // top-level `Class.X = …` assignment that esbuild treats as
      // side-effectful, pinning the whole class against tree-shaking in the
      // single-file dist (T-21). Use a module-level const. (Static methods and
      // uninitialized static declarations — e.g. a singleton holder — don't
      // lower, so they're not matched. The `pnpm size` DCE budget is the
      // definitive backstop.)
      "no-restricted-syntax": [
        "error",
        {
          selector: "PropertyDefinition[static=true][value]",
          message:
            "No initialized static class fields — they break dist tree-shaking under the ES2020 target (T-21). Use a module-level const.",
        },
      ],
    },
  },

  // Tests: mocks/spies legitimately use casts, `any`, and unbound methods.
  // Bug-signal rules (e.g. no-floating-promises) stay ON.
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Test mocks use static fields freely — they never ship in dist.
      "no-restricted-syntax": "off",
    },
  },

  // e2e specs and build/test config files are outside the src tsconfig, so they
  // use the non-type-checked preset (no project required).
  {
    files: ["e2e/**/*.ts", "*.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
