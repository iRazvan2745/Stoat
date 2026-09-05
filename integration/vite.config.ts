import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
    resolve: {
        alias: {
            "#lib": fileURLToPath(new URL("../src/lib", import.meta.url)),
            "$app/env/private": fileURLToPath(new URL("./env.ts", import.meta.url)),
        },
    },
    test: {
        include: ["integration/**/*.test.ts"],
        hookTimeout: 30_000,
        testTimeout: 30_000,
    },
});
