// oxlint-disable func-style no-await-in-loop
import { DATABASE_URL } from "$app/env/private";
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
    service_id: v.string(),
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
    snapshot?: DeploymentSnapshot;
    deployment_id: string;
    service_id: string;
}

const jsonSafeSnapshot = (snapshot: DeploymentSnapshot): DeploymentSnapshot =>
    JSON.parse(JSON.stringify(snapshot)) as DeploymentSnapshot;

class DeploymentQueueJob extends Job.make("deployment", {
    dedupe: ({ service_id, git_commit }) =>
        git_commit ? `${service_id}:${git_commit}` : service_id,
    defaults: { attempts: 1 },
    payload: {
        git_commit: Schema.optionalKey(Schema.String),
        deployment_id: Schema.String,
        service_id: Schema.String,
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

    return Boolean(deployment?.finishedAt);
}

async function processDeployment(
    { deployment_id: deploymentId, service_id: serviceId, snapshot }: DeploymentJob,
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
            serviceId,
        });
        return;
    }

    const startedMessage = `Deployment started for service ${serviceId}`;

    evlog.info({
        action: "deployment.started",
        deploymentId,
        serviceId,
    });
    // Legacy jobs cannot preserve the user's original input; require a new deployment.
    if (!snapshot) {
        await markDeploymentFailed(
            deploymentId,
            "Deployment predates configuration snapshots; enqueue a new deployment",
        );
        return;
    }
    const svc = snapshot.service;
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
            serviceId,
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
        await prepareDeployment(snapshot, deploymentId, controller.signal);

        if (await isDeploymentTerminal(deploymentId)) {
            evlog.info({
                action: "deployment.stopped_after_terminal_state",
                deploymentId,
                serviceId,
            });
            return;
        }

        const finishedMessage = `Deployment completed for service ${svc?.slug}`;
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
            serviceId,
            serviceSlug: svc?.slug,
        });
    } catch (error) {
        if (await isDeploymentTerminal(deploymentId)) {
            evlog.info({
                action: "deployment.stopped_after_terminal_state",
                deploymentId,
                serviceId,
            });
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        evlog.error({
            action: "deployment.failed",
            deploymentId,
            error: errorDetails(error),
            outcome: "failed",
            serviceId,
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
    const service_id = snapshot.service.id;
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
                serviceId: service_id,
                settings: snapshot.service.settings,
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
                : `Deployment queued for service ${service_id}`,
            stream: "debug",
        });

        return createdDeployment;
    });

    evlog.info({
        action: "deployment.queued",
        deploymentId: deployment.id,
        serviceId: service_id,
    });

    try {
        const jobId = await deploymentQueueRuntime.runPromise(
            DeploymentQueueJob.enqueue(
                {
                    deployment_id: deployment.id,
                    git_commit: snapshot.gitCommit,
                    service_id,
                    snapshot: jsonSafeSnapshot(snapshot),
                },
                { jobId: deployment.id },
            ),
        );

        if (jobId !== deployment.id) {
            await db.delete(deployments).where(eq(deployments.id, deployment.id));
            throw new Error("A deployment is already queued for this service");
        }

        return { deploymentId: deployment.id, jobId };
    } catch (error) {
        evlog.error({
            action: "deployment.enqueue_failed",
            deploymentId: deployment.id,
            error: errorDetails(error),
            outcome: "failed",
            serviceId: service_id,
        });
        await db.delete(deployments).where(eq(deployments.id, deployment.id));
        throw error;
    }
}

export async function startDeployment({ service_id }: v.InferOutput<typeof StartDeploymentInput>) {
    const snapshot = await captureDeploymentSnapshot(service_id);
    if (!snapshot.git.url) return await enqueueDeployment(snapshot);
    const { publishServiceDeployment } = await import("#lib/server/git-sources/sync");
    return await publishServiceDeployment(snapshot);
}

export async function deployService(id: string) {
    return await startDeployment({ service_id: id });
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

export async function reconcileFailedDeployments(serviceId: string): Promise<void> {
    const now = Date.now();
    const lastRun = reconcileLastRunAt.get(serviceId);

    if (lastRun !== undefined && now - lastRun < RECONCILE_MIN_INTERVAL_MS) {
        return;
    }

    reconcileLastRunAt.set(serviceId, now);

    const unfinished = await db
        .select({
            createdAt: deployments.createdAt,
            id: deployments.id,
            queueState: effectMqJobs.state,
        })
        .from(deployments)
        .leftJoin(effectMqJobs, eq(effectMqJobs.id, deployments.jobId))
        .where(and(eq(deployments.serviceId, serviceId), isNull(deployments.finishedAt)));

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
        const unfinishedServices = await db
            .selectDistinct({ serviceId: deployments.serviceId })
            .from(deployments)
            .where(isNull(deployments.finishedAt));
        for (const { serviceId } of unfinishedServices) {
            await reconcileFailedDeployments(serviceId);
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
