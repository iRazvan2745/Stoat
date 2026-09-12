import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
    resolve: {
        alias: {
            "#lib": fileURLToPath(new URL("src/lib", import.meta.url)),
            "$app/env/private": fileURLToPath(
                new URL("tests/integration/env.ts", import.meta.url)
            ),
        },
    },
    test: {
        // Every test file resets the shared schema in beforeAll, so files
        // must not run against the database in parallel.
        fileParallelism: false,
        hookTimeout: 30_000,
        include: ["tests/integration/**/*.test.ts"],
        testTimeout: 30_000,
    },
});
