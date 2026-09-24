import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "./index";
import { clusterMonitoring, clusters, projects, resources } from "./schema";

export async function getInitialization(db: Database, clusterId: string) {
    const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

    if (!cluster?.initializationConfiguration || !cluster.initializationRequestedAt) {
        throw new Error("Cluster initialization has not been requested.");
    }

    return cluster;
}

export async function prepareMonitoring(
    db: Database,
    clusterId: string,
    encryptedPassword: string,
    template: string,
) {
    return db.transaction(async (tx) => {
        const [cluster] = await tx
            .select()
            .from(clusters)
            .where(eq(clusters.id, clusterId))
            .for("update");

        if (!cluster?.initializationConfiguration)
            throw new Error("Missing initialization configuration.");

        const [existing] = await tx
            .select()
            .from(clusterMonitoring)
            .where(eq(clusterMonitoring.clusterId, clusterId));

        if (existing) return existing;
        const projectId = randomUUID();
        const resourceId = randomUUID();
        await tx.insert(projects).values({
            id: projectId,
            clusterId,
            name: "Monitoring",
            isInternal: true,
            description: "System-managed cluster metrics and logs.",
        });
        await tx.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Monitoring",
            type: "compose",
            draftSpec: template,
            settings: cluster.initializationConfiguration,
        });

        const [state] = await tx
            .insert(clusterMonitoring)
            .values({
                clusterId,
                projectId,
                resourceId,
                machineId: cluster.initializationConfiguration.machineId,
                encryptedPassword,
            })
            .returning();

        return state!;
    });
}

export function listInitializationRequests(db: Database) {
    return db
        .select({ clusterId: clusters.id, status: clusters.initializationStatus })
        .from(clusters)
        .where(
            and(
                isNotNull(clusters.initializationRequestedAt),
                isNull(clusters.initializedAt),
                inArray(clusters.initializationStatus, ["queued", "running", "retrying", "failed"]),
            ),
        );
}

export async function setInitializationStatus(
    db: Database,
    clusterId: string,
    status: "running" | "retrying" | "failed" | "ready",
    error: string | null,
) {
    const changes: Partial<typeof clusters.$inferInsert> = {
        initializationStatus: status,
        initializationError: error,
    };

    if (status === "ready") {
        changes.initializedAt = new Date();
        changes.greptimeUrl = "http://stoat-monitoring-greptimedb.internal:4006";
    }

    await db
        .update(clusters)
        .set(changes)
        .where(and(eq(clusters.id, clusterId), isNull(clusters.initializedAt)));
}

/** Replace stored monitoring credentials, e.g. after the app secret rotated. */
export async function updateMonitoringPassword(
    db: Database,
    clusterId: string,
    encryptedPassword: string,
) {
    await db
        .update(clusterMonitoring)
        .set({ encryptedPassword })
        .where(eq(clusterMonitoring.clusterId, clusterId));
}
