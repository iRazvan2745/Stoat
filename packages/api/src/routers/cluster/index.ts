import { ORPCError } from "@orpc/server";
import { clusters, projects } from "@stoat/db/schema/index";
import { ucClient, unwrap } from "@stoat/uncloud";
import { and, asc, eq, ilike, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { organizationProcedure, uncloudMiddleware } from "../..";
import { deploymentsRouter } from "./deployments";
import { initializationRouter, monitoringRouter } from "./initialization";
import { metricsRouter } from "./metrics";

const clusterInput = v.object({
    clusterId: v.pipe(v.string(), v.uuid()),
});

async function getClusterDiagnostics(sidecarUrl: string, sidecarToken: string) {
    try {
        return await unwrap(
            ucClient(sidecarUrl, { token: sidecarToken }).GET("/api/v1/cluster/diagnostics"),
        );
    } catch {
        return null;
    }
}

export const clusterRouter = {
    ...initializationRouter,
    ...deploymentsRouter,
    ...monitoringRouter,
    ...metricsRouter,
    listClusters: organizationProcedure
        .input(
            v.optional(
                v.object({
                    q: v.optional(v.string()),
                    limit: v.optional(
                        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
                    ),
                    offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
                }),
            ),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const limit = input?.limit ?? 25;
            const offset = input?.offset ?? 0;
            const q = input?.q;

            const pattern = q ? `%${q.replace(/([%_])/g, "\\$1")}%` : null;

            const conditions = pattern
                ? and(eq(clusters.organizationId, organizationId), ilike(clusters.name, pattern))
                : eq(clusters.organizationId, organizationId);

            // Connection credentials must never be included in the browser response.
            const items = await db
                .select({
                    id: clusters.id,
                    name: clusters.name,
                    organizationId: clusters.organizationId,
                    initializedAt: clusters.initializedAt,
                    createdAt: clusters.createdAt,
                    updatedAt: clusters.updatedAt,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                    projectCount: sql<number>`count(${projects.id}) filter (where ${projects.isInternal} is not true)::int`,
                })
                .from(clusters)
                .leftJoin(projects, eq(projects.clusterId, clusters.id))
                .where(conditions)
                .groupBy(
                    clusters.id,
                    clusters.name,
                    clusters.organizationId,
                    clusters.initializedAt,
                    clusters.createdAt,
                    clusters.updatedAt,
                    clusters.sidecarUrl,
                    clusters.sidecarToken,
                )
                .orderBy(asc(clusters.createdAt))
                .limit(limit)
                .offset(offset);

            const [row] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(clusters)
                .where(conditions);

            const itemsWithDiagnostics = await Promise.all(
                items.map(async ({ sidecarUrl, sidecarToken, ...item }) => {
                    const diagnostics = await getClusterDiagnostics(sidecarUrl, sidecarToken);

                    return { ...item, diagnostics };
                }),
            );

            return { items: itemsWithDiagnostics, total: row?.count ?? 0 };
        }),

    getCluster: organizationProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const [cluster] = await db
                .select({
                    id: clusters.id,
                    name: clusters.name,
                    organizationId: clusters.organizationId,
                    initializedAt: clusters.initializedAt,
                    initializationStatus: clusters.initializationStatus,
                    initializationError: clusters.initializationError,
                    createdAt: clusters.createdAt,
                    updatedAt: clusters.updatedAt,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                    projectCount: sql<number>`count(${projects.id}) filter (where ${projects.isInternal} is not true)::int`,
                })
                .from(clusters)
                .leftJoin(projects, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .groupBy(
                    clusters.id,
                    clusters.name,
                    clusters.organizationId,
                    clusters.initializedAt,
                    clusters.createdAt,
                    clusters.updatedAt,
                    clusters.sidecarUrl,
                    clusters.sidecarToken,
                )
                .limit(1);

            if (!cluster) {
                throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });
            }

            const { sidecarUrl, sidecarToken, ...item } = cluster;
            const diagnostics = await getClusterDiagnostics(sidecarUrl, sidecarToken);

            const canInitialize = organizationRole
                .split(",")
                .some((role) => role.trim() === "owner" || role.trim() === "admin");

            return { ...item, diagnostics, canInitialize };
        }),

    createCluster: organizationProcedure
        .input(
            v.object({
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                sidecarUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
                sidecarToken: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
                greptimeUrl: v.optional(
                    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
                ),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .insert(clusters)
                .values({
                    id: randomUUID(),
                    name: input.name.trim(),
                    sidecarUrl: input.sidecarUrl.trim(),
                    sidecarToken: input.sidecarToken.trim(),
                    greptimeUrl: input.greptimeUrl?.trim() ? input.greptimeUrl.trim() : null,
                    organizationId,
                })
                .returning({
                    id: clusters.id,
                    name: clusters.name,
                    organizationId: clusters.organizationId,
                    initializedAt: clusters.initializedAt,
                    createdAt: clusters.createdAt,
                    updatedAt: clusters.updatedAt,
                });

            return { ...cluster, projectCount: 0 };
        }),

    deleteCluster: organizationProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id, initializationStatus: clusters.initializationStatus })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) {
                throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });
            }

            if (["queued", "running", "retrying"].includes(cluster.initializationStatus)) {
                throw new ORPCError("CONFLICT", {
                    message:
                        "Wait for cluster initialization to finish before deleting this connection.",
                });
            }

            await db
                .delete(clusters)
                .where(
                    and(
                        eq(clusters.id, cluster.id),
                        eq(clusters.initializationStatus, cluster.initializationStatus),
                    ),
                );

            return { id: cluster.id };
        }),
    healthz: organizationProcedure
        .input(clusterInput)
        .use(uncloudMiddleware)
        .handler(({ context: { uc } }) => unwrap(uc.GET("/api/v1/cluster/diagnostics"))),
};
