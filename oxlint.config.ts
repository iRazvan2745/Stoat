import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import svelte from "ultracite/oxlint/svelte";

export default defineConfig({
  extends: [core, svelte],
  ignorePatterns: core.ignorePatterns,
  rules: {
    "func-style": "off",
    "no-nested-ternary": "off",
    "unicorn/require-module-specifiers": "off",
  },
});
