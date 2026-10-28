import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import oxlint from "eslint-plugin-oxlint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Interface + namespace merging is the chosen single-export-per-file pattern.
      "@typescript-eslint/no-namespace": "off",
    },
  },
  // Turn off everything oxlint already checks so the two don't overlap.
  ...oxlint.configs["flat/recommended"],
  prettier,
);
