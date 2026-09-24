import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Client, type Notification } from "pg";
import type { Database } from "./index";
import {
    type ClusterInitializationConfiguration,
    deploymentLogs,
    deployments,
    type DeploymentStatus,
} from "./schema";

export type Deployment = typeof deployments.$inferSelect;

export type DeploymentLog = typeof deploymentLogs.$inferSelect;

const MAX_LOGS = 2000;

export async function createDeployment(
    db: Pick<Database, "insert">,
    input: {
        clusterId: string;
        name: string;
        jobId: string;
        resourceId?: string | null;
        configuration?: ClusterInitializationConfiguration | null;
    },
) {
    const [row] = await db
        .insert(deployments)
        .values({
            id: randomUUID(),
            clusterId: input.clusterId,
            name: input.name,
            status: "queued",
            jobId: input.jobId,
            resourceId: input.resourceId ?? null,
            configuration: input.configuration ?? null,
        })
        .returning();

    return row!;
}

export async function getDeploymentByJobId(db: Database, jobId: string) {
    const [row] = await db.select().from(deployments).where(eq(deployments.jobId, jobId)).limit(1);

    return row ?? null;
}

export async function setDeploymentStatus(
    db: Database,
    id: string,
    status: DeploymentStatus,
    error: string | null = null,
) {
    await db
        .update(deployments)
        .set({
            status,
            error,
            ...(status === "ready" || status === "failed" || status === "cancelled"
                ? { finishedAt: new Date() }
                : { finishedAt: null }),
        })
        .where(and(eq(deployments.id, id), ne(deployments.status, "cancelled")));
}

/** Atomically mark an active deployment cancelled. Returns null when it already settled. */
export async function cancelDeployment(db: Database, id: string) {
    const [row] = await db
        .update(deployments)
        .set({
            status: "cancelled",
            error: "Cancelled by user.",
            finishedAt: new Date(),
        })
        .where(and(eq(deployments.id, id), inArray(deployments.status, ["queued", "running"])))
        .returning();

    return row ?? null;
}

export async function appendDeploymentLog(
    db: Database,
    deploymentId: string,
    text: string,
    metadata: DeploymentLog["metadata"] = {},
) {
    const line = text.trim();

    if (!line) return;
    await db.insert(deploymentLogs).values({ deploymentId, text: line, metadata });
}

export function listDeployments(db: Database, clusterId: string, limit = 20) {
    return db
        .select()
        .from(deployments)
        .where(eq(deployments.clusterId, clusterId))
        .orderBy(desc(deployments.createdAt))
        .limit(limit);
}

export async function getDeploymentWithLogs(db: Database, id: string) {
    const [deployment] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);

    if (!deployment) return null;

    const logs = await db
        .select()
        .from(deploymentLogs)
        .where(eq(deploymentLogs.deploymentId, id))
        .orderBy(asc(deploymentLogs.id))
        .limit(MAX_LOGS);

    return { ...deployment, logs };
}

/** The null IDs are a subscription-ready event: invalidate once to close the list/read race. */
export async function* watchDeploymentChanges(
    db: Database,
    options: { signal?: AbortSignal; deploymentId?: string; includeLogs?: boolean } = {},
): AsyncGenerator<{ deploymentId: string | null; clusterId: string | null }> {
    const { signal, deploymentId, includeLogs = true } = options;
    const channel = includeLogs ? "deployment_changes" : "deployment_list_changes";

    if (signal?.aborted) return;

    // LISTEN requires a session, not a transaction-pooled connection. Keep long-lived
    // listeners outside the query pool so subscribers cannot starve their own reads.
    const client = new Client(db.$client.options);
    const pending = new Map<string, string>();
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= client.end());

    const abort = () => {
        void close();
        wake?.();
    };

    const fail = (error: Error) => {
        failure = error;
        wake?.();
    };

    const ended = () => fail(new Error("Deployment notification connection closed."));

    const notify = (notification: Notification) => {
        if (notification.channel !== channel || !notification.payload) return;

        // The trigger sends two UUIDs separated by ':', never log text or Compose input.
        const [id, clusterId] = notification.payload.split(":");

        if (!id || !clusterId || (deploymentId && id !== deploymentId)) return;

        pending.set(id, clusterId);
        wake?.();
    };

    client.on("notification", notify);
    client.on("error", fail);
    client.on("end", ended);
    signal?.addEventListener("abort", abort, { once: true });

    try {
        // pg can leave connect() pending when end() interrupts the handshake.
        const interrupted = new Promise<void>((resolve) => {
            wake = resolve;
        });

        await Promise.race([client.connect(), interrupted]);
        wake = undefined;

        if (signal?.aborted) return;

        if (failure) throw failure;

        await client.query(`LISTEN ${channel}`);

        if (signal?.aborted) return;

        // Notifications are already buffered before the caller performs its first read.
        yield { deploymentId: null, clusterId: null };

        while (!signal?.aborted) {
            if (failure) throw failure;

            if (pending.size === 0) {
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
                wake = undefined;
                continue;
            }

            for (const [id, clusterId] of pending) {
                pending.delete(id);

                if (signal?.aborted) return;

                yield { deploymentId: id, clusterId };
            }
        }
    } catch (error) {
        if (!signal?.aborted) throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
        await close();
        client.removeListener("notification", notify);
        client.removeListener("error", fail);
        client.removeListener("end", ended);
    }
}

/** Replay all committed logs, then read only on notifications. Final logs precede terminal status. */
export async function* watchDeployment(
    db: Database,
    id: string,
    options: { afterId?: number; signal?: AbortSignal } = {},
): AsyncGenerator<{ deployment: Deployment; logs: DeploymentLog[]; complete: boolean }> {
    let cursor = options.afterId ?? 0;

    for await (const _change of watchDeploymentChanges(db, { ...options, deploymentId: id })) {
        const [deployment] = await db.select().from(deployments).where(eq(deployments.id, id));

        if (!deployment || options.signal?.aborted) return;

        let logs: DeploymentLog[];

        do {
            logs = await db
                .select()
                .from(deploymentLogs)
                .where(and(eq(deploymentLogs.deploymentId, id), gt(deploymentLogs.id, cursor)))
                .orderBy(asc(deploymentLogs.id))
                .limit(MAX_LOGS);

            if (options.signal?.aborted) return;

            cursor = logs.at(-1)?.id ?? cursor;
            yield {
                deployment,
                logs,
                complete:
                    ["ready", "failed", "cancelled"].includes(deployment.status) &&
                    logs.length < MAX_LOGS,
            };
        } while (logs.length === MAX_LOGS);

        if (["ready", "failed", "cancelled"].includes(deployment.status)) return;
    }
}
