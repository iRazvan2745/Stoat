import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import evlog from "evlog/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    varlockVitePlugin({ ssrInjectMode: "auto-load" }),
    tailwindcss(),
    sveltekit(),
    evlog({ service: "stoat-web" }),
  ],
});
