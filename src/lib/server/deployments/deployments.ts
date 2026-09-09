// oxlint-disable func-style no-await-in-loop
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { APP_SECRET, DATABASE_URL } from "$app/env/private";
import { PgClient } from "@effect/sql-pg";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { Job, JobStore, Worker } from "effect-mq";
import { DrizzleJobStore } from "effect-mq/drizzle-postgres";
import { log as evlog } from "evlog";
import * as v from "valibot";

import { db } from "#lib/db";
import {
    deploymentLogs,
    deployments,
    effectMqDedupe,
    effectMqFlowChildren,
    effectMqFlowOutbox,
    effectMqJobAttempts,
    effectMqJobs,
    effectMqQueues,
    effectMqSchedules,
} from "#lib/db/schema";
import { deploymentRecoveryReason } from "#lib/domain/deployments/recovery";
import { prepareDeployment } from "#lib/server/deployments/deployment-prepare";

import { captureDeploymentSnapshot } from "./deployment-snapshot";
import type { DeploymentSnapshot } from "./deployment-snapshot";

const StartDeploymentInput = v.object({
    resource_id: v.string(),
});

const DEPLOYMENT_QUEUE = "deployments";

const RECONCILE_MIN_INTERVAL_MS = 10_000;

const errorDetails = (caught: unknown): Record<string, string> => {
    if (caught instanceof Error) {
        return {
            message: caught.message,
            name: caught.name,
            ...(caught.stack ? { stack: caught.stack } : {}),
        };
    }

    return { message: String(caught) };
};

interface DeploymentJob {
    deployment_id: string;
    resource_id: string;
    snapshot?: unknown;
}

const jsonSafeSnapshot = (snapshot: DeploymentSnapshot): DeploymentSnapshot =>
    JSON.parse(JSON.stringify(snapshot)) as DeploymentSnapshot;

const DEPLOYMENT_SNAPSHOT_VERSION = "v1";

const deploymentSnapshotKey = (): Buffer => {
    if (!APP_SECRET?.trim()) {
        throw new Error("APP_SECRET is required to encrypt deployment snapshots");
    }

    return createHash("sha256").update(APP_SECRET).digest();
};

/** Keep credentials and environment secrets out of the durable queue payload. */
const encryptDeploymentSnapshot = (snapshot: DeploymentSnapshot): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deploymentSnapshotKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        DEPLOYMENT_SNAPSHOT_VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
    ].join(".");
};

const decryptDeploymentSnapshot = (encoded: string): DeploymentSnapshot => {
    const [version, encodedIv, encodedTag, encodedCiphertext] = encoded.split(".");

    if (
        version !== DEPLOYMENT_SNAPSHOT_VERSION ||
        !encodedIv ||
        !encodedTag ||
        !encodedCiphertext
    ) {
        throw new Error("Unsupported deployment snapshot");
    }

    try {
        const decipher = createDecipheriv(
            "aes-256-gcm",
            deploymentSnapshotKey(),
            Buffer.from(encodedIv, "base64url"),
        );
        decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(encodedCiphertext, "base64url")),
            decipher.final(),
        ]);
        const snapshot: unknown = JSON.parse(plaintext.toString("utf8"));

        if (
            typeof snapshot !== "object" ||
            snapshot === null ||
            !("resource" in snapshot) ||
            !("source" in snapshot) ||
            !("git" in snapshot) ||
            !("workspace" in snapshot) ||
            !("environment" in snapshot)
        ) {
            throw new Error("Invalid deployment snapshot");
        }

        return snapshot as DeploymentSnapshot;
    } catch (error) {
        if (error instanceof Error && error.message === "Unsupported deployment snapshot") {
            throw error;
        }

        throw new Error("Unable to decrypt deployment snapshot", { cause: error });
    }
};

const decodeDeploymentSnapshot = async (
    encoded: unknown,
): Promise<DeploymentSnapshot | undefined> => {
    if (encoded === undefined) {
        return undefined;
    }

    // Jobs created before encrypted snapshots were introduced stored the
    // object directly. Keep those jobs drainable while all new jobs use the
    // encrypted representation above.
    if (typeof encoded !== "string") {
        return encoded as DeploymentSnapshot;
    }

    return decryptDeploymentSnapshot(encoded);
};

class DeploymentQueueJob extends Job.make("deployment", {
    dedupe: ({ resource_id, git_commit }: { git_commit?: string; resource_id: string }) =>
        git_commit ? `${resource_id}:${git_commit}` : resource_id,
    defaults: { attempts: 1 },
    payload: {
        git_commit: Schema.optionalKey(Schema.String),
        deployment_id: Schema.String,
        resource_id: Schema.String,
        snapshot: Schema.optionalKey(Schema.Unknown),
    },
    queue: DEPLOYMENT_QUEUE,
}) {}

/** Abort controllers for deployments currently being processed in this instance. */
const activeDeployments = new Map<string, AbortController>();

async function getDeploymentRecord(deploymentId: string) {
    const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

    return deployment;
}

async function isDeploymentTerminal(deploymentId: string): Promise<boolean> {
    const deployment = await getDeploymentRecord(deploymentId);

    return deployment === undefined || Boolean(deployment.finishedAt);
}

async function processDeployment(
    {
        deployment_id: deploymentId,
        resource_id: resourceId,
        snapshot: encodedSnapshot,
    }: DeploymentJob,
    workerSignal?: AbortSignal,
): Promise<void> {
    const existing = await getDeploymentRecord(deploymentId);

    if (!existing || existing.outcome === "cancelled" || existing.finishedAt) {
        let reason: "already_finished" | "cancelled" | "missing";

        if (existing === undefined) {
            reason = "missing";
        } else if (existing.outcome === "cancelled") {
            reason = "cancelled";
        } else {
            reason = "already_finished";
        }

        evlog.info({
            action: "deployment.skipped",
            deploymentId,
            reason,
            resourceId,
        });
        return;
    }

    let snapshot: DeploymentSnapshot | undefined;
    try {
        snapshot = await decodeDeploymentSnapshot(encodedSnapshot);
    } catch (error) {
        evlog.error({
            action: "deployment.snapshot_decrypt_failed",
            deploymentId,
            error: errorDetails(error),
            outcome: "failed",
            resourceId,
        });
        await markDeploymentFailed(deploymentId, "Deployment snapshot could not be read");
        return;
    }

    const startedMessage = `Deployment started for resource ${resourceId}`;

    evlog.info({
        action: "deployment.started",
        deploymentId,
        resourceId,
    });
    // Manual deploys enqueue with a DB snapshot but no Git commit so the API
    // stays instant. Run Git sync here in the worker before uncloud deploy.
    // Snapshot-less jobs (previous instant path) fall back to capturing here.
    if (!snapshot) {
        try {
            const fresh = await captureDeploymentSnapshot(resourceId);
            if (fresh.git.url) {
                const { attachGitCommitToSnapshot } = await import("#lib/server/git-sources/sync");
                await attachGitCommitToSnapshot(fresh);
            }
            snapshot = fresh;
            await db
                .update(deployments)
                .set({
                    gitCommit: fresh.gitCommit,
                    settings: fresh.resource.settings,
                })
                .where(eq(deployments.id, deploymentId));
            if (await isDeploymentTerminal(deploymentId)) {
                evlog.info({
                    action: "deployment.skipped",
                    deploymentId,
                    reason: "finished_before_worker_started",
                    resourceId,
                });
                return;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            evlog.error({
                action: "deployment.prepare_failed",
                deploymentId,
                error: errorDetails(error),
                outcome: "failed",
                resourceId,
            });
            await markDeploymentFailed(deploymentId, message);
            return;
        }
    } else if (snapshot.git.url && !snapshot.gitCommit) {
        try {
            const { attachGitCommitToSnapshot } = await import("#lib/server/git-sources/sync");
            await attachGitCommitToSnapshot(snapshot);
            await db
                .update(deployments)
                .set({
                    gitCommit: snapshot.gitCommit,
                    settings: snapshot.resource.settings,
                })
                .where(eq(deployments.id, deploymentId));
            if (await isDeploymentTerminal(deploymentId)) {
                evlog.info({
                    action: "deployment.skipped",
                    deploymentId,
                    reason: "finished_before_worker_started",
                    resourceId,
                });
                return;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            evlog.error({
                action: "deployment.git_sync_failed",
                deploymentId,
                error: errorDetails(error),
                outcome: "failed",
                resourceId,
            });
            await markDeploymentFailed(deploymentId, message);
            return;
        }
    }
    const resource = snapshot.resource;
    const started = await db.transaction(async (tx) => {
        const updated = await tx
            .update(deployments)
            .set({
                startedAt: new Date(),
            })
            .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
            .returning({ id: deployments.id });
        if (updated.length === 0) {
            return false;
        }

        await tx.insert(deploymentLogs).values({
            deploymentId,
            message: startedMessage,
            stream: "debug",
        });
        return true;
    });
    if (!started) {
        evlog.info({
            action: "deployment.skipped",
            deploymentId,
            reason: "finished_before_worker_started",
            resourceId,
        });
        return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    workerSignal?.addEventListener("abort", abort, { once: true });
    if (workerSignal?.aborted) {
        controller.abort();
    }
    activeDeployments.set(deploymentId, controller);

    try {
        // Cancellation can win the race between the started transaction and
        // registering the in-process abort controller. Check the durable
        // terminal state after registration so a cancelled deployment never
        // starts Git or Uncloud work.
        if (controller.signal.aborted || (await isDeploymentTerminal(deploymentId))) {
            return;
        }

        await prepareDeployment(snapshot, deploymentId, controller.signal);

        if (await isDeploymentTerminal(deploymentId)) {
            evlog.info({
                action: "deployment.stopped_after_terminal_state",
                deploymentId,
                resourceId,
            });
            return;
        }

        const finishedMessage = `Deployment completed for resource ${resource?.slug}`;
        await db.transaction(async (tx) => {
            const updated = await tx
                .update(deployments)
                .set({ finishedAt: new Date(), outcome: "success" })
                .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
                .returning({ id: deployments.id });
            if (updated.length > 0) {
                await tx.insert(deploymentLogs).values({
                    deploymentId,
                    message: finishedMessage,
                    stream: "debug",
                });
            }
        });
        evlog.info({
            action: "deployment.completed",
            deploymentId,
            resourceId,
            resourceSlug: resource?.slug,
        });
    } catch (error) {
        if (await isDeploymentTerminal(deploymentId)) {
            evlog.info({
                action: "deployment.stopped_after_terminal_state",
                deploymentId,
                resourceId,
            });
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        evlog.error({
            action: "deployment.failed",
            deploymentId,
            error: errorDetails(error),
            outcome: "failed",
            resourceId,
        });
        await db.transaction(async (tx) => {
            const updated = await tx
                .update(deployments)
                .set({ finishedAt: new Date(), outcome: "failed" })
                .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
                .returning({ id: deployments.id });
            if (updated.length > 0) {
                await tx.insert(deploymentLogs).values({
                    deploymentId,
                    message,
                    stream: "stderr",
                });
            }
        });
    } finally {
        workerSignal?.removeEventListener("abort", abort);
        activeDeployments.delete(deploymentId);
    }
}

const JobStoreLive = DrizzleJobStore.layer({
    attempts: effectMqJobAttempts,
    dedupe: effectMqDedupe,
    flowChildren: effectMqFlowChildren,
    flowOutbox: effectMqFlowOutbox,
    jobs: effectMqJobs,
    queues: effectMqQueues,
    schedules: effectMqSchedules,
}).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(DATABASE_URL) })));

const DeploymentQueueLive = DeploymentQueueJob.toLayer(
    (payload) => Effect.promise((signal) => processDeployment(payload as DeploymentJob, signal)),
    { concurrency: 1 },
).pipe(Layer.provideMerge(Worker.layer()), Layer.provideMerge(JobStoreLive));

const deploymentQueueRuntime = ManagedRuntime.make(DeploymentQueueLive);

export async function shutdownDeploymentWorker(): Promise<void> {
    workerDisposed = true;
    clearTimeout(reconciliationTimer);
    await deploymentQueueRuntime.dispose();
}

const { hot } = import.meta as { hot?: { dispose: (fn: () => void) => void } };
hot?.dispose(() => {
    void shutdownDeploymentWorker();
});

let queueReady: Promise<void> | undefined;

async function initializeQueue(): Promise<void> {
    evlog.info({ action: "deployment_worker.starting" });
    await deploymentQueueRuntime.context();
    evlog.info({ action: "deployment_worker.started" });
    void reconcileWorkerDeployments();
}

export async function ensureDeploymentWorker(): Promise<void> {
    const ready = (queueReady ??= initializeQueue());

    try {
        await ready;
    } catch (error) {
        if (queueReady === ready) {
            queueReady = undefined;
        }
        evlog.error({
            action: "deployment_worker.startup",
            error: errorDetails(error),
            outcome: "failed",
        });
        throw error;
    }
}

export async function enqueueDeployment(
    snapshot: DeploymentSnapshot,
    options: { deploymentId?: string } = {},
) {
    await ensureDeploymentWorker();
    const resource_id = snapshot.resource.id;
    const deploymentId = options.deploymentId ?? crypto.randomUUID();
    const existing = await getDeploymentRecord(deploymentId);
    if (existing?.finishedAt) return { deploymentId, jobId: existing.jobId ?? deploymentId };

    const deployment = await db.transaction(async (tx) => {
        const [createdDeployment] = await tx
            .insert(deployments)
            .values({
                id: deploymentId,
                jobId: deploymentId,
                gitCommit: snapshot.gitCommit,
                queuedAt: new Date(),
                resourceId: resource_id,
                settings: snapshot.resource.settings,
            })
            .onConflictDoNothing()
            .returning({ id: deployments.id });

        if (!createdDeployment && existing) return { id: existing.id };
        if (!createdDeployment) {
            throw new Error("Unable to create deployment");
        }

        await tx.insert(deploymentLogs).values({
            deploymentId: createdDeployment.id,
            message: snapshot.gitCommit
                ? `Deployment queued for Git commit ${snapshot.gitCommit}`
                : `Deployment queued for resource ${resource_id}`,
            stream: "debug",
        });

        return createdDeployment;
    });

    evlog.info({
        action: "deployment.queued",
        deploymentId: deployment.id,
        resourceId: resource_id,
    });

    try {
        const jobId = await deploymentQueueRuntime.runPromise(
            DeploymentQueueJob.enqueue(
                {
                    deployment_id: deployment.id,
                    ...(snapshot.gitCommit ? { git_commit: snapshot.gitCommit } : {}),
                    resource_id,
                    snapshot: encryptDeploymentSnapshot(jsonSafeSnapshot(snapshot)),
                },
                { jobId: deployment.id },
            ),
        );

        if (jobId !== deployment.id) {
            await db.delete(deployments).where(eq(deployments.id, deployment.id));
            throw new Error("A deployment is already queued for this resource");
        }

        return { deploymentId: deployment.id, jobId };
    } catch (error) {
        evlog.error({
            action: "deployment.enqueue_failed",
            deploymentId: deployment.id,
            error: errorDetails(error),
            outcome: "failed",
            resourceId: resource_id,
        });
        await db.delete(deployments).where(eq(deployments.id, deployment.id));
        throw error;
    }
}

export async function startDeployment({ resource_id }: v.InferOutput<typeof StartDeploymentInput>) {
    // Instant: capture a DB-only snapshot and enqueue. Git sync + uncloud
    // deploy run in the worker, so the API returns in ms.
    const snapshot = await captureDeploymentSnapshot(resource_id);
    return await enqueueDeployment(snapshot);
}

export async function requestDeployment(resourceId: string) {
    const snapshot = await captureDeploymentSnapshot(resourceId);
    return await enqueueDeployment(snapshot);
}

export async function deployResource(id: string) {
    return await startDeployment({ resource_id: id });
}

export async function cancelDeployment(deploymentId: string): Promise<void> {
    await ensureDeploymentWorker();

    evlog.info({ action: "deployment.cancellation_requested", deploymentId });

    const deployment = await getDeploymentRecord(deploymentId);

    if (!deployment) {
        throw new Error("Deployment not found");
    }

    if (deployment.finishedAt) {
        throw new Error("Deployment is already finished");
    }

    await db.transaction(async (tx) => {
        const updated = await tx
            .update(deployments)
            .set({ finishedAt: new Date(), outcome: "cancelled" })
            .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
            .returning({ id: deployments.id });
        if (updated.length > 0) {
            await tx.insert(deploymentLogs).values({
                deploymentId,
                message: "Deployment force cancelled",
                stream: "stderr",
            });
        }
    });

    // Abort in-flight work (git push / deploy stream) after the record is
    // marked cancelled, so the worker sees the terminal state and stops quietly.
    activeDeployments.get(deploymentId)?.abort();

    if (deployment.jobId) {
        try {
            await deploymentQueueRuntime.runPromise(
                DeploymentQueueJob.cancel(JobStore.JobId(deployment.jobId)),
            );
        } catch (error) {
            evlog.warn({
                action: "deployment.queue_cancellation_failed",
                deploymentId,
                error: errorDetails(error),
            });
        }
    }

    evlog.info({ action: "deployment.cancelled", deploymentId });
}

export async function deleteDeployment(deploymentId: string): Promise<void> {
    evlog.info({ action: "deployment.deletion_requested", deploymentId });
    const deployment = await getDeploymentRecord(deploymentId);

    if (!deployment) {
        throw new Error("Deployment not found");
    }

    if (!deployment.finishedAt) {
        throw new Error("Deployment is still running — cancel it before deleting");
    }

    await db.delete(deployments).where(eq(deployments.id, deploymentId));
    evlog.info({ action: "deployment.deleted", deploymentId });
}

async function markDeploymentFailed(deploymentId: string, reason?: string): Promise<void> {
    await db.transaction(async (tx) => {
        const updated = await tx
            .update(deployments)
            .set({ finishedAt: new Date(), outcome: "failed" })
            .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
            .returning({ id: deployments.id });

        if (updated.length > 0 && reason) {
            await tx.insert(deploymentLogs).values({
                deploymentId,
                message: reason,
                stream: "stderr",
            });
        }
    });
}

const reconcileLastRunAt = new Map<string, number>();

export async function reconcileFailedDeployments(resourceId: string): Promise<void> {
    const now = Date.now();
    const lastRun = reconcileLastRunAt.get(resourceId);

    if (lastRun !== undefined && now - lastRun < RECONCILE_MIN_INTERVAL_MS) {
        return;
    }

    reconcileLastRunAt.set(resourceId, now);

    const unfinished = await db
        .select({
            createdAt: deployments.createdAt,
            id: deployments.id,
            queueState: effectMqJobs.state,
        })
        .from(deployments)
        .leftJoin(effectMqJobs, eq(effectMqJobs.id, deployments.jobId))
        .where(and(eq(deployments.resourceId, resourceId), isNull(deployments.finishedAt)));

    for (const deployment of unfinished) {
        const reason = deploymentRecoveryReason(
            deployment.queueState ?? undefined,
            deployment.createdAt,
            now,
        );
        if (reason) {
            await markDeploymentFailed(deployment.id, reason);
        }
    }
}

let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
let workerDisposed = false;

async function reconcileWorkerDeployments(): Promise<void> {
    try {
        const unfinishedResources = await db
            .selectDistinct({ resourceId: deployments.resourceId })
            .from(deployments)
            .where(isNull(deployments.finishedAt));
        for (const { resourceId } of unfinishedResources) {
            await reconcileFailedDeployments(resourceId);
        }
    } catch (error) {
        evlog.warn({
            action: "deployment.reconciliation_failed",
            error: errorDetails(error),
        });
    } finally {
        if (!workerDisposed) {
            reconciliationTimer = setTimeout(() => {
                void reconcileWorkerDeployments();
            }, RECONCILE_MIN_INTERVAL_MS);
            reconciliationTimer.unref();
        }
    }
}
