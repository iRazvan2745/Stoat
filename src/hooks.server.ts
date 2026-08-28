import { building } from "$app/env";
import { redirect } from "@sveltejs/kit";
import type { Handle, ServerInit } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { initLogger } from "evlog";
import { createEvlogHooks } from "evlog/sveltekit";

import { auth } from "#lib/auth";

initLogger({
  env: { service: "app" },
  redact: true,
});

const handleBetterAuth: Handle = ({ event, resolve }) =>
  svelteKitHandler({ auth, building, event, resolve });

const PUBLIC_PATH_PREFIXES = ["/login", "/api/auth"];

// SvelteKit internals (assets, remote function endpoints) must not be
// redirected to HTML; remote functions enforce auth themselves via
// requireSession and return 401 instead.
const isGuardedPath = (pathname: string): boolean =>
  !(
    pathname.startsWith("/_app/") ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );

const handleSession: Handle = async ({ event, resolve }) => {
  event.locals.session = await auth.api.getSession({
    headers: event.request.headers,
  });

  if (!event.locals.session && isGuardedPath(event.url.pathname)) {
    redirect(303, "/login");
  }

  return await resolve(event);
};

const evlogHooks = createEvlogHooks({ redact: true });

export const handle: Handle = sequence(evlogHooks.handle, handleBetterAuth, handleSession);
export const { handleError } = evlogHooks;

export const init: ServerInit = async () => {
  if (building) {
    return;
  }

  // Start the deployment worker at boot so jobs queued before a restart are
  // picked up without waiting for someone to trigger a new deployment.
  const { ensureDeploymentWorker } = await import("#lib/server/deployments/deployments");

  try {
    await ensureDeploymentWorker();
  } catch (error) {
    console.error("Deployment worker failed to start; it will retry on the next deployment", error);
  }
};
