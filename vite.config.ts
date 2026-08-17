import adapter from "@sveltejs/adapter-auto";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  fmt: { ignorePatterns: ["**/schema.d.ts"] },
  optimizeDeps: {
    exclude: [
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/lang-yaml",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      "@lezer/yaml",
      "codemirror",
      "svelte-codemirror-editor",
    ],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    options: { typeAware: true, typeCheck: true },
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
  },
  plugins: lazyPlugins(() => [
    tailwindcss(),
    sveltekit({
      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter(),
      compilerOptions: {
        experimental: { async: true },
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/u).includes("node_modules") ? undefined : true,
      },
      experimental: {
        explicitEnvironmentVariables: true,
        remoteFunctions: true,
      },
    }),
    functionsMixins({ deps: ["m3-svelte"] }),
    {
      // Keep Lightning CSS from parsing m3-svelte's custom mixin syntax.
      config: () => ({ build: { cssMinify: false } }),
      name: "stoat-m3-css",
    },
  ]),
  staged: {
    "*": "vp check --fix",
  },
});
