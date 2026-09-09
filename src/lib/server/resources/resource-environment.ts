// oxlint-disable func-style
import { asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { environmentVariables, resources } from "#lib/db/schema";
import type { EnvironmentVariable } from "#lib/domain/environment";

export async function listEnvironmentVariables(resourceId: string) {
    return await db
        .select()
        .from(environmentVariables)
        .where(eq(environmentVariables.resourceId, resourceId))
        .orderBy(asc(environmentVariables.name));
}

export async function replaceEnvironmentVariables(
    resourceId: string,
    variables: readonly EnvironmentVariable[],
) {
    const [resource] = await db
        .select({ id: resources.id })
        .from(resources)
        .where(eq(resources.id, resourceId));

    if (!resource) {
        throw new Error("Resource not found");
    }

    return await db.transaction(async (tx) => {
        await tx
            .delete(environmentVariables)
            .where(eq(environmentVariables.resourceId, resourceId));

        if (variables.length === 0) {
            return [];
        }

        return await tx
            .insert(environmentVariables)
            .values(
                variables.map((variable) => ({
                    name: variable.name,
                    resourceId,
                    value: variable.value,
                })),
            )
            .returning();
    });
}

export async function deleteEnvironmentVariablesForResource(resourceId: string): Promise<void> {
    await db.delete(environmentVariables).where(eq(environmentVariables.resourceId, resourceId));
}

// Deprecated alias for callers still migrating from the services naming.
export { deleteEnvironmentVariablesForResource as deleteEnvironmentVariablesForService };
