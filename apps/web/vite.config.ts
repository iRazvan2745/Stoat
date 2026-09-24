import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import evlog from "evlog/vite";
import { defineConfig } from "vite-plus";
import { monitoringWorker } from "./worker-plugin";

export default defineConfig({
    test: {
        include: ["../../tests/web/**/*.test.ts", "src/**/*.test.ts"],
    },
    plugins: [
        monitoringWorker(),
        varlockVitePlugin({ ssrInjectMode: "auto-load" }),
        tailwindcss(),
        sveltekit(),
        evlog({ service: "stoat-web" }),
    ],
});
