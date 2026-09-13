import { building, dev } from "$app/environment";
import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";

import "./lib/orpc.server";
import { createAuthMiddleware, type BetterAuthInstance } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { createEvlogHooks } from "evlog/sveltekit";

import { auth } from "./services";

const { handle: evlogHandle, handleError } = createEvlogHooks({
  drain: dev ? createFsDrain() : undefined,
});

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
  exclude: ["/api/auth/**"],
  maskEmail: true,
});

const evlogAuthHandle: Handle = async ({ event, resolve }) => {
  await identifyUser(event.locals.log, event.request.headers, event.url.pathname);
  return resolve(event);
};

const authHandle: Handle = async ({ event, resolve }) => {
  const authInstance = auth;

  return svelteKitHandler({
    event,
    resolve,
    auth: authInstance,
    building,
  });
};

export const handle = sequence(evlogHandle as Handle, evlogAuthHandle, authHandle);
export { handleError };
