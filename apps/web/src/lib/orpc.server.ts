import { getRequestEvent } from "$app/server";
import { createRouterClient } from "@orpc/server";
import { appRouter, type AppRouterClient } from "@stoat/api/routers/index";

import { createContext } from "../context";

if (typeof window !== "undefined") {
    throw new Error("This file should only be imported on the server.");
}

const serverClient: AppRouterClient = createRouterClient(appRouter, {
    context: async () => {
        const event = getRequestEvent();

        return createContext({
            headers: event.request.headers,
        });
    },
});

// oRPC's SvelteKit SSR setup loads this from hooks.server.ts so $lib/orpc can
// reuse the in-process server client during SSR and fall back to HTTP in the browser.
globalThis.$client = serverClient;
