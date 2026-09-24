import { ORPCError } from "@orpc/server";
import {
    clusters,
    deployments,
    projects,
    resources,
    type DeploymentStatus,
} from "@stoat/db/schema/index";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { organizationProcedure } from "../..";

export const projectsRouter = {
    listProjects: organizationProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select({
                id: projects.id,
                name: projects.name,
                description: projects.description,
                clusterId: projects.clusterId,
                createdAt: projects.createdAt,
                updatedAt: projects.updatedAt,
                resourceCount: sql<number>`count(${resources.id})::int`,
            })
            .from(projects)
            .innerJoin(clusters, eq(projects.clusterId, clusters.id))
            .leftJoin(resources, eq(resources.projectId, projects.id))
            .where(
                and(
                    eq(clusters.organizationId, organizationId),
                    sql`${projects.isInternal} is not true`,
                ),
            )
            .groupBy(
                projects.id,
                projects.name,
                projects.description,
                projects.clusterId,
                projects.createdAt,
                projects.updatedAt,
            )
            .orderBy(asc(projects.createdAt)),
    ),

    listProjectOverviews: organizationProcedure.handler(
        async ({ context: { db, organizationId } }) => {
            const rows = await db
                .select({
                    id: projects.id,
                    name: projects.name,
                    description: projects.description,
                    clusterId: projects.clusterId,
                    clusterName: clusters.name,
                    createdAt: projects.createdAt,
                    updatedAt: projects.updatedAt,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(clusters.organizationId, organizationId),
                        sql`${projects.isInternal} is not true`,
                    ),
                )
                .orderBy(asc(projects.createdAt));

            if (rows.length === 0) return [];

            const latest = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    status: deployments.status,
                    createdAt: deployments.createdAt,
                })
                .from(deployments)
                .where(eq(deployments.name, "DeployResource"))
                .orderBy(deployments.resourceId, desc(deployments.createdAt))
                .as("latest");

            const resourceRows = await db
                .select({
                    id: resources.id,
                    name: resources.name,
                    projectId: resources.projectId,
                    updatedAt: resources.updatedAt,
                    status: latest.status,
                    deployedAt: latest.createdAt,
                })
                .from(resources)
                .leftJoin(latest, eq(latest.resourceId, resources.id))
                .where(
                    inArray(
                        resources.projectId,
                        rows.map((row) => row.id),
                    ),
                )
                .orderBy(asc(resources.createdAt));

            return rows.map((project) => {
                const items = resourceRows.filter((row) => row.projectId === project.id);

                const activity = items.reduce(
                    (value, item) =>
                        Math.max(
                            value,
                            item.updatedAt.getTime(),
                            item.deployedAt?.getTime() ?? 0,
                        ),
                    project.updatedAt.getTime(),
                );

                return {
                    ...project,
                    lastActivityAt: new Date(activity),
                    resources: items.map((item) => ({
                        id: item.id,
                        name: item.name,
                        status: (item.status ?? null) as DeploymentStatus | null,
                    })),
                };
            });
        },
    ),

    createProject: organizationProcedure
        .input(
            z.object({
                name: z.string().trim().min(1).max(100),
                description: z.string().trim().max(500).optional(),
                clusterId: z.string().uuid(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id })
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

            const description = input.description?.trim() ? input.description.trim() : null;

            const [project] = await db
                .insert(projects)
                .values({
                    id: randomUUID(),
                    name: input.name.trim(),
                    description,
                    clusterId: cluster.id,
                })
                .returning({
                    id: projects.id,
                    name: projects.name,
                    description: projects.description,
                    clusterId: projects.clusterId,
                    createdAt: projects.createdAt,
                    updatedAt: projects.updatedAt,
                });

            return { ...project, resourceCount: 0 };
        }),
};
