import { building, dev } from "$app/environment";
import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";

import "./lib/orpc.server";
import { createAuthMiddleware } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { createEvlogHooks } from "evlog/sveltekit";

import { getAuth } from "./services";
import { startMonitoringWorker } from "./lib/worker.server";

// Server modules also execute during `vite build` (SSR analysis). The worker
// must only run in a live server, never at build time.
if (!building) {
    startMonitoringWorker();
}

const { handle: evlogHandle, handleError } = createEvlogHooks({
    drain: dev ? createFsDrain() : undefined,
});

const evlogAuthHandle: Handle = async ({ event, resolve }) => {
    const identifyUser = createAuthMiddleware(getAuth(), {
        exclude: ["/api/auth/**"],
        maskEmail: true,
    });

    await identifyUser(event.locals.log, event.request.headers, event.url.pathname);

    return resolve(event);
};

const authHandle: Handle = async ({ event, resolve }) => {
    const authInstance = getAuth();

    return svelteKitHandler({
        event,
        resolve,
        auth: authInstance,
        building,
    });
};

export const handle = sequence(evlogHandle, evlogAuthHandle, authHandle);

export { handleError };
