import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
    ...ultracite,
    svelte: true,
    tabWidth: 4,
});
