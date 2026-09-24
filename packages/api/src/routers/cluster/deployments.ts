import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    cancelDeployment as cancelDeploymentRow,
    getDeploymentWithLogs,
    listDeployments,
    watchDeployment,
    watchDeploymentChanges,
} from "@stoat/db/deployments";
import { clusters, deployments } from "@stoat/db/schema/index";
import { cancelDeploymentJob } from "@stoat/workflows/runtime";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as v from "valibot";
import { organizationAdminProcedure, organizationProcedure } from "../..";
import { cancellableStream } from "../../stream";

function canInitializeRole(role: string) {
    return role.split(",").some((part) => part.trim() === "owner" || part.trim() === "admin");
}

async function requireOrgCluster(db: Database, organizationId: string, clusterId: string) {
    const [cluster] = await db
        .select({ id: clusters.id })
        .from(clusters)
        .where(and(eq(clusters.id, clusterId), eq(clusters.organizationId, organizationId)))
        .limit(1);

    if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

    return cluster;
}

export const deploymentsRouter = {
    streamDeployment: organizationProcedure
        .input(
            v.object({
                deploymentId: v.pipe(v.string(), v.uuid()),
                afterId: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            }),
        )
        .handler(({ context: { db, organizationId, organizationRole }, input, signal }) =>
            cancellableStream(async function* (signal) {
                const [deployment] = await db
                    .select({ clusterId: deployments.clusterId })
                    .from(deployments)
                    .where(eq(deployments.id, input.deploymentId));

                if (!deployment)
                    throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });

                await requireOrgCluster(db, organizationId, deployment.clusterId);

                for await (const event of watchDeployment(db, input.deploymentId, {
                    afterId: input.afterId,
                    signal,
                })) {
                    yield { ...event, canCancel: canInitializeRole(organizationRole) };
                }
            }, signal),
        ),

    watchDeployments: organizationProcedure.handler(({ context: { db, organizationId }, signal }) =>
        cancellableStream(async function* (signal) {
            for await (const change of watchDeploymentChanges(db, { signal, includeLogs: false })) {
                if (change.clusterId === null) {
                    yield { deploymentId: null };
                    continue;
                }

                const [cluster] = await db
                    .select({ id: clusters.id })
                    .from(clusters)
                    .where(
                        and(
                            eq(clusters.id, change.clusterId),
                            eq(clusters.organizationId, organizationId),
                        ),
                    );

                if (cluster) yield { deploymentId: change.deploymentId };
            }
        }, signal),
    ),

    listDeployments: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const cluster = await requireOrgCluster(db, organizationId, input.clusterId);

            return listDeployments(db, cluster.id, input.limit ?? 20);
        }),

    getDeployment: organizationProcedure
        .input(v.object({ deploymentId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const deployment = await getDeploymentWithLogs(db, input.deploymentId);

            if (!deployment) throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
            await requireOrgCluster(db, organizationId, deployment.clusterId);

            return { ...deployment, canCancel: canInitializeRole(organizationRole) };
        }),

    cancelDeployment: organizationAdminProcedure
        .input(v.object({ deploymentId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const deployment = await getDeploymentWithLogs(db, input.deploymentId);

            if (!deployment) throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
            await requireOrgCluster(db, organizationId, deployment.clusterId);
            // Freeze first so a concurrent worker cannot overwrite cancellation.
            const cancelled = await cancelDeploymentRow(db, deployment.id);

            if (!cancelled) {
                throw new ORPCError("CONFLICT", { message: "This deployment already settled." });
            }

            await cancelDeploymentJob(
                deployment.jobId,
                deployment.resourceId ? "DeployResource" : "InitializeCluster",
            );

            if (!deployment.resourceId)
                await db
                    .update(clusters)
                    .set({
                        initializationStatus: "failed",
                        initializationError: "Initialization was cancelled.",
                    })
                    .where(
                        and(
                            eq(clusters.id, deployment.clusterId),
                            isNull(clusters.initializedAt),
                            inArray(clusters.initializationStatus, [
                                "queued",
                                "running",
                                "retrying",
                            ]),
                        ),
                    );

            return { id: cancelled.id, status: "cancelled" as const };
        }),

    listAllDeployments: organizationProcedure
        .input(
            v.optional(
                v.object({
                    status: v.optional(
                        v.picklist(["queued", "running", "ready", "failed", "cancelled"]),
                    ),
                    limit: v.optional(
                        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
                    ),
                    offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
                    resourceId: v.optional(v.pipe(v.string(), v.uuid())),
                }),
            ),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const limit = input?.limit ?? 25;
            const offset = input?.offset ?? 0;
            const conditions = [eq(clusters.organizationId, organizationId)];

            if (input?.status) conditions.push(eq(deployments.status, input.status));
            const where = and(...conditions);

            const items = await db
                .select({
                    id: deployments.id,
                    clusterId: deployments.clusterId,
                    clusterName: clusters.name,
                    name: deployments.name,
                    status: deployments.status,
                    createdAt: deployments.createdAt,
                    updatedAt: deployments.updatedAt,
                    finishedAt: deployments.finishedAt,
                })
                .from(deployments)
                .innerJoin(clusters, eq(deployments.clusterId, clusters.id))
                .where(where)
                .orderBy(desc(deployments.createdAt))
                .limit(limit)
                .offset(offset);

            const [row] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(deployments)
                .innerJoin(clusters, eq(deployments.clusterId, clusters.id))
                .where(where);

            return { items, total: row?.count ?? 0 };
        }),
};
