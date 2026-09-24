import { createDb, type Database } from "@stoat/db";
import {
    appendDeploymentLog,
    getDeploymentByJobId,
    setDeploymentStatus,
} from "@stoat/db/deployments";
import { setInitializationStatus } from "@stoat/db/initialization";
import { JobStore, Worker } from "effect-mq";
import { Cause, Effect, Layer } from "effect";
import { createInitializeClusterHandler } from "./initialize-cluster";
import { deployResource, RESOURCE_FAILURE_MESSAGE } from "./deploy-resource";
import { DeployResource, InitializeCluster } from "./jobs";
import { JobStoreLive, PgLive } from "./store";

function requireEnv(name: string) {
    const value = process.env[name];

    if (!value) throw new Error(`${name} is required for cluster initialization.`);

    return value;
}

function createHandlerDb(): Database {
    return createDb({ DATABASE_URL: requireEnv("DATABASE_URL") });
}

function encryptionSecret() {
    return requireEnv("BETTER_AUTH_SECRET");
}

const TERMINAL_FAILURE_MESSAGE =
    "Cluster monitoring initialization failed. Check the selected machine, storage paths, and sidecar connectivity, then retry.";

// Plain async attempt: manages its own Pool lifecycle with try/finally.
// The AbortSignal comes from Effect.callback and aborts on interruption,
// timeout, or cancel so deployMonitoring stops promptly.
async function runAttemptAsync(clusterId: string, requestId: string, signal: AbortSignal) {
    const db = createHandlerDb();
    const jobId = `${clusterId}:${requestId}`;

    try {
        await setInitializationStatus(db, clusterId, "running", null).catch(() => {});
        const deployment = await getDeploymentByJobId(db, jobId).catch(() => null);

        if (deployment?.status === "cancelled") return;

        if (deployment && deployment.status !== "running") {
            await setDeploymentStatus(db, deployment.id, "running").catch(() => {});
        }

        signal.throwIfAborted();

        const handler = createInitializeClusterHandler(
            db,
            encryptionSecret(),
            deployment ? { deploymentId: deployment.id } : undefined,
        );

        try {
            await handler(clusterId, signal);
        } catch (error) {
            // Handler errors are fixed redacted strings, safe for the log.
            // Skipped on abort: interruption releases the job without an attempt.
            if (!signal.aborted && deployment) {
                const message =
                    error instanceof Error
                        ? error.message
                        : "Cluster monitoring initialization failed.";

                await appendDeploymentLog(db, deployment.id, `Step failed: ${message}`).catch(
                    () => {},
                );
            }

            throw error;
        }

        if (deployment) {
            await setDeploymentStatus(db, deployment.id, "ready").catch(() => {});
        }

        await setInitializationStatus(db, clusterId, "ready", null).catch(() => {});
    } finally {
        await db.$client.end().catch(() => {});
    }
}

function runAttempt(clusterId: string, requestId: string) {
    return Effect.callback<void>((resume, signal) => {
        const attempt = runAttemptAsync(clusterId, requestId, signal).then(
            () => resume(Effect.void),
            () => resume(Effect.die(new Error(TERMINAL_FAILURE_MESSAGE))),
        );

        // Drain pending writes before the timeout/failure hook publishes terminal status.
        return Effect.promise(() => attempt);
    });
}

export const InitializeClusterLive = InitializeCluster.toLayer(
    (payload) => runAttempt(payload.clusterId, payload.requestId),
    { concurrency: 1 },
);

export const DeployResourceLive = DeployResource.toLayer(
    ({ deploymentId }) =>
        Effect.callback<void>((resume, signal) => {
            const attempt = (async () => {
                const db = createHandlerDb();

                try {
                    await deployResource(db, deploymentId, signal);
                } finally {
                    await db.$client.end();
                }
            })().then(
                () => resume(Effect.void),
                () => resume(Effect.die(new Error(RESOURCE_FAILURE_MESSAGE))),
            );

            // Interruption aborts the signal, then drains writes and releases the lock
            // before effect-mq invokes its terminal failure hook or retries the job.
            return Effect.promise(() => attempt);
        }),
    { concurrency: 4 },
);

async function recordFailureAsync(failure: Worker.JobFailure) {
    // effect-mq namespaces deterministic ids as `<JobName>/<idempotencyKey>`,
    // so strip the prefix before matching our `${clusterId}:${requestId}` shape.
    const rawId = failure.jobId;
    const key = rawId.includes("/") ? rawId.slice(rawId.indexOf("/") + 1) : rawId;
    const sep = key.indexOf(":");
    const clusterId = sep === -1 ? key : key.slice(0, sep);
    const db = createHandlerDb();

    try {
        const deployment = key ? await getDeploymentByJobId(db, key).catch(() => null) : null;

        // A user-cancelled deployment already carries its final state.
        if (deployment?.status === "cancelled") return;

        if (failure.name === "DeployResource") {
            if (!deployment || !["queued", "running"].includes(deployment.status)) return;
            const cause = Cause.squash(failure.cause);

            const reason = Cause.isTimeoutError(cause)
                ? cause.message
                : (deployment.error ?? RESOURCE_FAILURE_MESSAGE);

            await appendDeploymentLog(
                db,
                deployment.id,
                failure.willRetry ? "Resource deployment attempt failed; retry scheduled." : reason,
                { level: "error", event: failure.willRetry ? "retry" : "failed" },
            );
            await setDeploymentStatus(
                db,
                deployment.id,
                failure.willRetry ? "queued" : "failed",
                reason,
            );

            return;
        }

        if (deployment) {
            await appendDeploymentLog(db, deployment.id, TERMINAL_FAILURE_MESSAGE, {
                level: "error",
                event: "failed",
            });
            await setDeploymentStatus(db, deployment.id, "failed", TERMINAL_FAILURE_MESSAGE).catch(
                () => {},
            );
        }

        if (clusterId) {
            await setInitializationStatus(db, clusterId, "failed", TERMINAL_FAILURE_MESSAGE).catch(
                () => {},
            );
        }
    } finally {
        await db.$client.end().catch(() => {});
    }
}

export const WorkerLive = Worker.layer({
    queues: {
        initialize: { concurrency: 1 },
        deploy: { concurrency: 4 },
    },
    lockDuration: "10 minutes",
    // effect-mq also delivers cross-process cancellation on this heartbeat.
    lockRenewInterval: "2 seconds",
    stalledInterval: "1 minute",
    maxStalledCount: 2,
    onJobFailure: (failure) => {
        if (
            failure.name !== "DeployResource" &&
            (failure.name !== "InitializeCluster" || failure.willRetry)
        )
            return Effect.void;

        return Effect.promise(() => recordFailureAsync(failure)).pipe(Effect.ignore);
    },
});

export const MonitoringWorkerLive = Layer.merge(InitializeClusterLive, DeployResourceLive).pipe(
    Layer.provideMerge(WorkerLive),
    Layer.provideMerge(JobStoreLive),
);

// Enqueue (or re-enqueue) initialization for a cluster. Idempotent per
// (clusterId, requestId) via the job's idempotencyKey.
export function enqueueInitialization(clusterId: string, requestId: string) {
    return InitializeCluster.enqueue({ clusterId, requestId });
}

export async function queueResourceDeployment(deploymentId: string): Promise<void> {
    await Effect.runPromise(
        DeployResource.enqueue({ deploymentId }).pipe(Effect.provide(JobStoreLive)),
    );
}

/**
 * Best-effort cancel of a queued or running deployment job.
 * effect-mq namespaces the stored jobId internally, which is added here. Never throws:
 * a missing or already-settled job simply means there is nothing to stop.
 */
export async function cancelDeploymentJob(
    jobId: string,
    name: "InitializeCluster" | "DeployResource" = "InitializeCluster",
): Promise<void> {
    try {
        const job = name === "DeployResource" ? DeployResource : InitializeCluster;

        const program = job
            .cancel(JobStore.JobId(`${name}/${jobId}`))
            .pipe(Effect.provide(JobStoreLive));

        await Effect.runPromise(program);
    } catch {
        /* ignore: already settled or never enqueued */
    }
}

async function pollOutboxAsync() {
    const db = createHandlerDb();

    try {
        const initialization = await db.$client.query<{ clusterId: string; requestedAt: Date }>(
            `SELECT id AS "clusterId", initialization_requested_at AS "requestedAt" FROM clusters
             WHERE initialization_status = 'queued' AND initialization_requested_at IS NOT NULL
             AND initialised_at IS NULL`,
        );

        const resources = await db.$client.query<{ deploymentId: string }>(
            `SELECT id AS "deploymentId" FROM deployments WHERE name = 'DeployResource' AND status = 'queued'`,
        );

        return { initialization: initialization.rows, resources: resources.rows };
    } finally {
        await db.$client.end().catch(() => {});
    }
}

// Sweep durable request rows, never deployment logs. Both job types are idempotent.
export function pollInitializationOutbox() {
    return Effect.promise(() => pollOutboxAsync()).pipe(
        Effect.flatMap(({ initialization, resources }) =>
            Effect.forEach(
                [
                    ...initialization.map((row) =>
                        enqueueInitialization(row.clusterId, row.requestedAt.toISOString()),
                    ),
                    ...resources.map((row) => DeployResource.enqueue(row)),
                ],
                (enqueue) => enqueue.pipe(Effect.catch(() => Effect.void)),
            ),
        ),
        Effect.catch(() => Effect.void),
    );
}

export { JobStoreLive, PgLive };

export { DeployResource, InitializeCluster };

export type { Database };
