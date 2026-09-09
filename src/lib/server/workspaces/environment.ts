// oxlint-disable func-style
import { asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { resources, workspace, workspaceEnvironmentVariables } from "#lib/db/schema";
import type { EnvironmentVariable } from "#lib/domain/environment";
import { mergeEnvironmentVariables } from "#lib/domain/environment";
import { listEnvironmentVariables as listResourceEnvironmentVariables } from "#lib/server/resources/resource-environment";

export async function listWorkspaceEnvironmentVariables(workspaceId: string) {
    return await db
        .select()
        .from(workspaceEnvironmentVariables)
        .where(eq(workspaceEnvironmentVariables.workspaceId, workspaceId))
        .orderBy(asc(workspaceEnvironmentVariables.name));
}

export async function replaceWorkspaceEnvironmentVariables(
    workspaceId: string,
    variables: readonly EnvironmentVariable[],
) {
    const [wrk] = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.id, workspaceId));

    if (!wrk) {
        throw new Error("Workspace not found");
    }

    return await db.transaction(async (tx) => {
        await tx
            .delete(workspaceEnvironmentVariables)
            .where(eq(workspaceEnvironmentVariables.workspaceId, workspaceId));

        if (variables.length === 0) {
            return [];
        }

        return await tx
            .insert(workspaceEnvironmentVariables)
            .values(
                variables.map((variable) => ({
                    name: variable.name,
                    value: variable.value,
                    workspaceId,
                })),
            )
            .returning();
    });
}

export async function deleteWorkspaceEnvironmentVariables(workspaceId: string): Promise<void> {
    await db
        .delete(workspaceEnvironmentVariables)
        .where(eq(workspaceEnvironmentVariables.workspaceId, workspaceId));
}

export async function resolveEffectiveEnvironmentVariables(
    workspaceId: string,
    resourceId: string,
): Promise<EnvironmentVariable[]> {
    const [workspaceVars, resourceVars] = await Promise.all([
        listWorkspaceEnvironmentVariables(workspaceId),
        listResourceEnvironmentVariables(resourceId),
    ]);

    // Resource-level variables win over workspace-level variables.
    return mergeEnvironmentVariables(workspaceVars, resourceVars);
}

export async function listEffectiveEnvironmentVariables(
    resourceId: string,
): Promise<EnvironmentVariable[]> {
    const [resource] = await db
        .select({ workspaceId: resources.workspaceId })
        .from(resources)
        .where(eq(resources.id, resourceId));

    if (!resource) {
        throw new Error("Resource not found");
    }

    return await resolveEffectiveEnvironmentVariables(resource.workspaceId, resourceId);
}
