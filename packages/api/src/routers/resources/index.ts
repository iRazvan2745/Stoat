import { ORPCError } from "@orpc/server";
import {
    clusters,
    deployments,
    deploymentLogs,
    projects,
    resources,
    resourceDeploymentInputs,
} from "@stoat/db/schema/index";
import { unwrap } from "@stoat/uncloud";
import { queueResourceDeployment } from "@stoat/workflows/runtime";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import {
    organizationAdminProcedure,
    organizationProcedure,
    resourceMiddleware,
    uncloudMiddleware,
} from "../..";
import { formatComposeFile, resourceComposePrefix } from "../../compose";
import {
    gitSourceInput,
    loadGitCompose,
    lockedComposeResource,
    resourceEditInput,
    resourceGitRouter,
} from "./git";
import { gitText } from "../connections";
import { resourceLogsRouter } from "./logs";

export const resourcesRouter = {
    ...resourceGitRouter,
    ...resourceLogsRouter,
    deploy: organizationAdminProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const id = await db.transaction(async (tx) => {
                const [row] = await tx
                    .select({ resource: resources, clusterId: projects.clusterId })
                    .from(resources)
                    .innerJoin(projects, eq(resources.projectId, projects.id))
                    .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                    .where(
                        and(
                            eq(resources.id, input.resourceId),
                            eq(projects.id, input.projectId),
                            eq(resources.type, "compose"),
                            sql`${projects.isInternal} is not true`,
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .for("update", { of: resources });

                if (!row)
                    throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
                const { resource, clusterId } = row;

                if (!resource.draftSpec?.trim())
                    throw new ORPCError("BAD_REQUEST", {
                        message: "Save a Compose spec before deploying.",
                    });

                if (Buffer.byteLength(resource.draftSpec) > 4 * 1024 * 1024)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "Compose must not exceed 4 MiB.",
                    });

                const prefix = resourceComposePrefix(resource) ?? "";

                try {
                    if (formatComposeFile(resource.draftSpec, prefix).serviceCount === 0)
                        throw new Error("Compose must contain at least one service.");
                } catch {
                    throw new ORPCError("BAD_REQUEST", {
                        message:
                            "Save a valid Compose spec containing at least one service before deploying.",
                    });
                }

                const [active] = await tx
                    .select({ id: deployments.id })
                    .from(deployments)
                    .where(
                        and(
                            eq(deployments.resourceId, resource.id),
                            inArray(deployments.status, ["queued", "running"]),
                        ),
                    )
                    .limit(1);

                if (active)
                    throw new ORPCError("CONFLICT", {
                        message: "This resource already has an active deployment.",
                    });

                const deploymentId = randomUUID();
                await tx.insert(deployments).values({
                    id: deploymentId,
                    jobId: deploymentId,
                    clusterId,
                    resourceId: resource.id,
                    name: "DeployResource",
                    status: "queued",
                });
                await tx
                    .insert(resourceDeploymentInputs)
                    .values({ deploymentId, spec: resource.draftSpec, prefix });
                await tx.insert(deploymentLogs).values({
                    deploymentId,
                    text: "Resource deployment queued. Saved Compose snapshot captured.",
                    metadata: { level: "info" },
                });

                return deploymentId;
            });

            // The deployment row is the durable outbox if enqueue is temporarily unavailable.
            await queueResourceDeployment(id).catch(() => {});

            return { id, status: "queued" as const };
        }),
    updateComposeSpec: organizationProcedure
        .input(
            v.object({
                ...resourceEditInput,
                spec: gitText,
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) =>
            db.transaction(async (tx) => {
                await lockedComposeResource(tx, input);

                const [resource] = await tx
                    .update(resources)
                    .set({ draftSpec: input.spec })
                    .where(eq(resources.id, input.resourceId))
                    .returning();

                return resource!;
            }),
        ),

    updateVariables: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                env: v.string(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const authorizedProjects = db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const [resource] = await db
                .update(resources)
                .set({
                    settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${input.env}::text)`,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        eq(resources.type, "compose"),
                        sql`${resources.projectId} in (${authorizedProjects})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    updateSettings: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                prefixNames: v.boolean(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const authorizedProjects = db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const [resource] = await db
                .update(resources)
                .set({
                    settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('prefixNames', ${input.prefixNames}::boolean)`,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        eq(resources.type, "compose"),
                        sql`${resources.projectId} in (${authorizedProjects})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    updateDetails: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                icon: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000_000))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const authorizedProjects = db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const description = input.description?.trim() ? input.description.trim() : null;
            const icon = input.icon?.trim() ? input.icon.trim() : null;

            const [resource] = await db
                .update(resources)
                .set({
                    name: input.name.trim(),
                    description,
                    icon,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        eq(resources.type, "compose"),
                        sql`${resources.projectId} in (${authorizedProjects})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    listResources: organizationProcedure
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            return db
                .select({
                    id: resources.id,
                    name: resources.name,
                    description: resources.description,
                    icon: resources.icon,
                    type: resources.type,
                    projectId: resources.projectId,
                    createdAt: resources.createdAt,
                    updatedAt: resources.updatedAt,
                })
                .from(resources)
                .where(eq(resources.projectId, input.projectId))
                .orderBy(asc(resources.createdAt));
        }),

    createResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                type: v.optional(v.picklist(["compose"]), "compose"),
                git: v.optional(gitSourceInput),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            const description = input.description?.trim() ? input.description.trim() : null;
            const source = input.git ? await loadGitCompose(db, organizationId, input.git) : {};

            const [resource] = await db
                .insert(resources)
                .values({
                    ...source,
                    id: randomUUID(),
                    name: input.name.trim(),
                    description,
                    type: input.type ?? "compose",
                    projectId: project.id,
                })
                .returning();

            return resource;
        }),

    getResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { resource } }) => resource),
    getContainers: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(uncloudMiddleware)
        .use(resourceMiddleware)
        .handler(async ({ context: { db, resource, uc } }) => {
            if (!resource.spec) {
                throw new ORPCError("NOT_FOUND", {
                    message: "Resource has no deployed compose spec.",
                });
            }

            const [snapshot] = await db
                .select({
                    spec: resourceDeploymentInputs.spec,
                    prefix: resourceDeploymentInputs.prefix,
                })
                .from(deployments)
                .innerJoin(
                    resourceDeploymentInputs,
                    eq(resourceDeploymentInputs.deploymentId, deployments.id),
                )
                .where(
                    and(
                        eq(deployments.resourceId, resource.id),
                        eq(deployments.name, "DeployResource"),
                        eq(deployments.status, "ready"),
                    ),
                )
                .orderBy(desc(deployments.finishedAt), desc(deployments.createdAt))
                .limit(1);

            const prefix = snapshot?.prefix ?? resourceComposePrefix(resource);
            let formatted;

            try {
                formatted = formatComposeFile(snapshot?.spec ?? resource.spec, prefix);
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", {
                    message: error instanceof Error ? error.message : "Invalid compose spec.",
                });
            }

            const containers = await Promise.all(
                formatted.serviceNames.map(async (id) => {
                    const result = await uc.GET("/api/v1/services/{id}", {
                        params: { path: { id } },
                    });

                    if (result.response.status === 404) return [];

                    const service = await unwrap(Promise.resolve(result));

                    return service.containers;
                }),
            );

            return containers.flat();
        }),
    getFormattedCompose: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { resource } }) => {
            if (!resource.draftSpec) {
                throw new ORPCError("NOT_FOUND", { message: "Resource has no compose draft." });
            }

            const prefix = resourceComposePrefix(resource);

            try {
                const formatted = formatComposeFile(resource.draftSpec, prefix);

                return { ...formatted, prefix };
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", {
                    message: error instanceof Error ? error.message : "Invalid compose spec.",
                });
            }
        }),
};
