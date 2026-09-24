import { defineConfig } from "jsrepo";

export default defineConfig({
    // configure where stuff comes from here
    registries: ["https://cossui-svelte.com/r"],
    // configure where stuff goes here
    // (mirrors upstream cossui-svelte paths so `$lib/...` targets resolve to src/lib)
    paths: {
        ui: "./src/lib/components/ui",
        component: "./src/lib/components",
        block: "./src/lib/components/particles",
        hook: "./src/lib/hooks",
        util: "./src/lib/utils",
        lib: "./src/lib",
    },
});
