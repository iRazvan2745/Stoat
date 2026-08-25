import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import svelte from "ultracite/oxlint/svelte";

export default defineConfig({
  extends: [core, svelte],
  // src/lib/components/flow is vendored from sv-animations; keep it close to
  // upstream instead of restyling it to local lint rules.
  ignorePatterns: [...(core.ignorePatterns ?? []), "src/lib/components/flow/**"],
  rules: {
    "func-style": "off",
    "no-nested-ternary": "off",
    "unicorn/require-module-specifiers": "off",
  },
});
