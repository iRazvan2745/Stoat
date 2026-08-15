import { building } from "$app/env";
import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { initLogger } from "evlog";
import { createEvlogHooks } from "evlog/sveltekit";

import { auth } from "#lib/server/auth";

initLogger({
  env: { service: "stoat" },
  redact: true,
});

const handleBetterAuth: Handle = ({ event, resolve }) =>
  svelteKitHandler({ auth, building, event, resolve });

const evlogHooks = createEvlogHooks({ redact: true });

export const handle: Handle = sequence(evlogHooks.handle, handleBetterAuth);
export const { handleError } = evlogHooks;
