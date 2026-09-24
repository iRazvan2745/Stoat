import { ORPCError, os } from "@orpc/server";

import { getOrganizationMembership } from "@stoat/db/organizations";
import { clusters, projects, resources } from "@stoat/db/schema/index";
import { ucClient } from "@stoat/uncloud";
import { and, eq, sql } from "drizzle-orm";

import type { Context } from "./context";

export const o = os.$context<Context>();

export const publicProcedure = o;

const requireAuth = o.middleware(async ({ context, next }) => {
    if (!context.session?.user) {
        throw new ORPCError("UNAUTHORIZED");
    }

    return next({
        context: {
            session: context.session,
        },
    });
});

export const protectedProcedure = publicProcedure.use(requireAuth);

export const organizationProcedure = protectedProcedure.use(async ({ context, next }) => {
    const organizationId = context.session.session.activeOrganizationId;

    const membership = organizationId
        ? await getOrganizationMembership(context.db, context.session.user.id, organizationId)
        : null;

    if (!organizationId || !membership) {
        throw new ORPCError("FORBIDDEN", { message: "Select an organization you belong to." });
    }

    return next({ context: { organizationId, organizationRole: membership.role } });
});

export const organizationAdminProcedure = organizationProcedure.use(async ({ context, next }) => {
    if (
        !context.organizationRole
            .split(",")
            .some((role) => role.trim() === "owner" || role.trim() === "admin")
    ) {
        throw new ORPCError("FORBIDDEN", {
            message: "This action requires an organization owner or admin.",
        });
    }

    return next();
});

export const uncloudMiddleware = organizationProcedure.middleware(
    async ({ context: { db, organizationId }, next }, input: { clusterId: string }) => {
        const [cluster] = await db
            .select({
                sidecarUrl: clusters.sidecarUrl,
                sidecarToken: clusters.sidecarToken,
            })
            .from(clusters)
            .where(
                and(eq(clusters.id, input.clusterId), eq(clusters.organizationId, organizationId)),
            )
            .limit(1);

        if (!cluster) {
            throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });
        }

        return next({
            context: {
                uc: ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken }),
            },
        });
    },
);

export const resourceMiddleware = organizationProcedure.middleware(
    async (
        { context: { db, organizationId }, next },
        input: { projectId: string; resourceId: string; clusterId?: string },
    ) => {
        const [project] = await db
            .select({ id: projects.id })
            .from(projects)
            .innerJoin(clusters, eq(projects.clusterId, clusters.id))
            .where(
                and(
                    eq(projects.id, input.projectId),
                    input.clusterId === undefined
                        ? undefined
                        : eq(projects.clusterId, input.clusterId),
                    sql`${projects.isInternal} is not true`,
                    eq(clusters.organizationId, organizationId),
                ),
            )
            .limit(1);

        if (!project) {
            throw new ORPCError("NOT_FOUND", { message: "Project not found." });
        }

        const [resource] = await db
            .select()
            .from(resources)
            .where(
                and(eq(resources.id, input.resourceId), eq(resources.projectId, input.projectId)),
            )
            .limit(1);

        if (!resource) {
            throw new ORPCError("NOT_FOUND", { message: "Resource not found." });
        }

        return next({ context: { resource } });
    },
);
