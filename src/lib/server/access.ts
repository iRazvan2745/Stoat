import { and, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, gitSource, member, resources, workspace } from "#lib/db/schema";

export const hasAccessToThisDataSource = async (
    userId: string,
    dataSourceId: string,
): Promise<boolean> => {
    const [row] = await db
        .select({ id: dataSource.id })
        .from(dataSource)
        .innerJoin(member, eq(member.organizationId, dataSource.organizationId))
        .where(and(eq(dataSource.id, dataSourceId), eq(member.userId, userId)))
        .limit(1);

    return row !== undefined;
};

export const hasAccessToThisGitSource = async (
    userId: string,
    gitSourceId: string,
): Promise<boolean> => {
    const [match] = await db
        .select({ id: gitSource.id })
        .from(gitSource)
        .innerJoin(member, eq(member.organizationId, gitSource.organizationId))
        .where(and(eq(gitSource.id, gitSourceId), eq(member.userId, userId)))
        .limit(1);

    return match !== undefined;
};

export const hasAccessToThisWorkspace = async (
    userId: string,
    workspaceId: string,
): Promise<boolean> => {
    const [row] = await db
        .select({ id: workspace.id })
        .from(workspace)
        .innerJoin(member, eq(member.organizationId, workspace.organizationId))
        .where(and(eq(workspace.id, workspaceId), eq(member.userId, userId)))
        .limit(1);

    return row !== undefined;
};

export const hasAccessToThisResource = async (
    userId: string,
    resourceId: string,
): Promise<boolean> => {
    const [row] = await db
        .select({ id: resources.id })
        .from(resources)
        .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
        .innerJoin(member, eq(member.organizationId, workspace.organizationId))
        .where(and(eq(resources.id, resourceId), eq(member.userId, userId)))
        .limit(1);

    return row !== undefined;
};

export const getOrganizationIdForUser = async (
    userId: string,
    preferredOrganizationId?: string | null,
): Promise<string | null> => {
    if (preferredOrganizationId) {
        const [membership] = await db
            .select({ organizationId: member.organizationId })
            .from(member)
            .where(
                and(eq(member.userId, userId), eq(member.organizationId, preferredOrganizationId)),
            )
            .limit(1);

        if (membership) {
            return membership.organizationId;
        }
    }

    const [fallback] = await db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, userId))
        .limit(1);

    return fallback?.organizationId ?? null;
};
