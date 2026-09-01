import { building } from "$app/env";
import { redirect } from "@sveltejs/kit";
import type { Handle, ServerInit } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { initLogger, log as evlog } from "evlog";
import { createEvlogHooks } from "evlog/sveltekit";

import {
    getRemoteLogger,
    hasRemoteHandlerRun,
    hasRemoteFailure,
    inspectRemoteResponse,
    logRemoteError,
    logRemoteRequest,
    logRemoteResponse,
    parseRemoteInvocation,
} from "#lib/api/remote-logging";
import { auth } from "#lib/auth";

initLogger({
    env: { service: "app" },
    redact: true,
});

const handleBetterAuth: Handle = ({ event, resolve }) =>
    svelteKitHandler({ auth, building, event, resolve });

const PUBLIC_PATH_PREFIXES = ["/login", "/api/auth", "/healthz"];

// SvelteKit internals (assets, remote function endpoints) must not be
// redirected to HTML; remote functions enforce auth themselves via
// requireSession and return 401 instead.
const isGuardedPath = (pathname: string): boolean =>
    !(
        pathname.startsWith("/_app/") ||
        PUBLIC_PATH_PREFIXES.some(
            (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        )
    );

const handleSession: Handle = async ({ event, resolve }) => {
    if (event.url.pathname === "/healthz") {
        return await resolve(event);
    }

    event.locals.session = await auth.api.getSession({
        headers: event.request.headers,
    });

    if (!event.locals.session && isGuardedPath(event.url.pathname)) {
        redirect(303, "/login");
    }

    return await resolve(event);
};

const handleRemoteLogging: Handle = async ({ event, resolve }) => {
    if (!event.isRemoteRequest) {
        return await resolve(event);
    }

    const invocation = parseRemoteInvocation(event.request, event.url.pathname);
    const logger = getRemoteLogger();

    if (invocation) {
        logRemoteRequest(logger, invocation);
    } else {
        logger?.info("remote.requested", {
            operation: "remote.unknown",
            remote: {
                method: event.request.method,
                pagePath: event.url.pathname,
                transport: "other",
                type: "unknown",
            },
        });
    }

    try {
        const response = await resolve(event);

        if (event.locals.session) {
            logger?.set({ user: { id: event.locals.session.user.id } });
        }

        const inspection = await inspectRemoteResponse(response, !hasRemoteHandlerRun(logger));
        const operation = invocation?.functionName ?? "unknown";

        if (inspection.outcome === "error" && !hasRemoteFailure(logger)) {
            logRemoteError(
                logger,
                operation,
                new Error(
                    `Remote function ${operation} failed: ${inspection.message ?? "Unknown error"}`,
                ),
                inspection.status,
            );
        }

        logRemoteResponse(logger, operation, inspection);

        return response;
    } catch (error) {
        logRemoteError(logger, invocation?.functionName ?? "unknown", error);
        throw error;
    }
};

const evlogHooks = createEvlogHooks({ redact: true });

export const handle: Handle = sequence(
    evlogHooks.handle,
    handleBetterAuth,
    handleRemoteLogging,
    handleSession,
);
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
        evlog.error({
            action: "deployment_worker.startup",
            error: error instanceof Error ? error.message : String(error),
            outcome: "failed",
        });
    }
};
