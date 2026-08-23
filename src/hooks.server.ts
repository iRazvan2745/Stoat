import { building } from "$app/env";
import type { Handle, ServerInit } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { initLogger } from "evlog";
import { createEvlogHooks } from "evlog/sveltekit";

import { auth } from "#lib/server/auth";

initLogger({
  env: { service: "app" },
  redact: true,
});

const handleBetterAuth: Handle = ({ event, resolve }) =>
  svelteKitHandler({ auth, building, event, resolve });

const evlogHooks = createEvlogHooks({ redact: true });

export const handle: Handle = sequence(evlogHooks.handle, handleBetterAuth);
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
