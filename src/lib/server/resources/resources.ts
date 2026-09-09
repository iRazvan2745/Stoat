// oxlint-disable func-style
import fs from "node:fs/promises";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { resources, workspace } from "#lib/db/schema";
import type { EnvironmentVariable } from "#lib/domain/environment";
import { normalizeResourceIcon } from "#lib/domain/resources/icon";
import { normalizeResourceName } from "#lib/domain/resources/identity";
import type { ResourceSettings } from "#lib/domain/resources/settings";
import {
    mergeResourceSettings,
    parseResourceSettings,
    shouldPrefixResources,
} from "#lib/domain/resources/settings";
import { expandTemplateSecrets, expandTemplateVariables } from "#lib/domain/templates";
import { createWorkspaceFolder, workspacePath } from "#lib/server/data-sources/paths";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import {
    addComposeIngressRoute,
    deleteComposeIngressRoute,
    updateComposeIngressRoute,
} from "#lib/server/resources/compose-ingress-routes";
import type { ComposeIngressRouteInput } from "#lib/server/resources/compose-ingress-routes";
import {
    deleteEnvironmentVariablesForResource,
    replaceEnvironmentVariables,
} from "#lib/server/resources/resource-environment";
import { uniqueSlug } from "#lib/server/shared/slugs";
import { readTemplateIconValue, readTemplateVersion } from "#lib/server/templates";

export interface CreateResourceInput {
    icon?: string;
    name: string;
    type: string;
    value: string;
    variables: readonly EnvironmentVariable[];
    workspaceId: string;
}

export async function getResource(id: string) {
    const [op] = await db.select().from(resources).where(eq(resources.id, id));

    return op;
}

export async function listResourcesInWorkspace(workspaceId: string) {
    // Null sort orders land last, so brand new resources show up at the end.
    return await db
        .select()
        .from(resources)
        .where(eq(resources.workspaceId, workspaceId))
        .orderBy(asc(resources.sortOrder), asc(resources.id));
}

export async function createResource({
    icon,
    name,
    type,
    value,
    variables,
    workspaceId,
}: CreateResourceInput) {
    const [workspaceRecord] = await db
        .select({
            slug: workspace.slug,
            workspaceId: workspace.id,
        })
        .from(workspace)
        .where(eq(workspace.id, workspaceId));

    if (!workspaceRecord) {
        throw new Error("Workspace not found");
    }

    const slug = await uniqueSlug(name, async (candidate) => {
        const matches = await db
            .select({ slug: resources.slug })
            .from(resources)
            .where(eq(resources.slug, candidate));

        return matches.length > 0;
    });

    const [created] = await db
        .insert(resources)
        .values({
            icon: normalizeResourceIcon(icon),
            name: normalizeResourceName(name),
            slug,
            type,
            value,
            workspaceId,
        })
        .returning();

    if (!created) {
        throw new Error("Unable to create resource");
    }

    try {
        await createWorkspaceFolder(
            workspacePath(workspaceId),
            workspaceRecord.slug,
            created.slug ?? slug,
        );

        if (variables.length > 0) {
            await replaceEnvironmentVariables(created.id, variables);
        }
    } catch (error) {
        await deleteEnvironmentVariablesForResource(created.id);
        await db.delete(resources).where(eq(resources.id, created.id));
        throw error;
    }

    return created;
}

export async function createResourceFromTemplate({
    appId,
    name,
    version,
    workspaceId,
}: {
    appId: string;
    name: string;
    version: string;
    workspaceId: string;
}) {
    const template = await readTemplateVersion(appId, version);

    return await createResource({
        icon: (await readTemplateIconValue(appId, template.manifest.icon)) ?? undefined,
        name,
        type: template.manifest.type,
        value: expandTemplateSecrets(template.compose),
        variables: expandTemplateVariables(template.variables),
        workspaceId,
    });
}

export async function copyResource(resourceId: string, targetWorkspaceId: string) {
    const resource = await getResource(resourceId);

    if (!resource) {
        throw new Error("Resource not found");
    }

    if (resource.workspaceId === targetWorkspaceId) {
        throw new Error("Choose a different workspace for the copy");
    }

    return await createResource({
        name: resource.name ?? "Copied resource",
        type: "compose",
        value: resource.value ?? "",
        variables: [],
        workspaceId: targetWorkspaceId,
    });
}

export async function moveResource(resourceId: string, targetWorkspaceId: string) {
    const [record] = await db
        .select({
            resource: resources,
            sourceDataSourceId: workspace.dataSourceId,
            sourceWorkspaceId: workspace.id,
            sourceWorkspaceSlug: workspace.slug,
        })
        .from(resources)
        .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
        .where(eq(resources.id, resourceId));

    if (!record) {
        throw new Error("Resource not found");
    }

    if (record.sourceWorkspaceId === targetWorkspaceId) {
        throw new Error("Resource is already in that workspace");
    }

    const [targetWorkspace] = await db
        .select({
            dataSourceId: workspace.dataSourceId,
            id: workspace.id,
            slug: workspace.slug,
        })
        .from(workspace)
        .where(
            and(
                eq(workspace.id, targetWorkspaceId),
                eq(workspace.dataSourceId, record.sourceDataSourceId),
            ),
        );

    if (!targetWorkspace) {
        throw new Error("Resources can only move between workspaces using the same data source");
    }

    const resourceFolder = record.resource.slug ?? record.resource.id;
    const sourceFolder = path.join(
        workspacePath(record.sourceWorkspaceId),
        record.sourceWorkspaceSlug,
        resourceFolder,
    );
    const targetParent = await createWorkspaceFolder(
        workspacePath(targetWorkspace.id),
        targetWorkspace.slug,
    );
    const targetFolder = path.join(targetParent, resourceFolder);

    let movedExistingFolder = false;

    try {
        await fs.rename(sourceFolder, targetFolder);
        movedExistingFolder = true;
    } catch (error) {
        const sourceFolderMissing =
            error instanceof Error && "code" in error && error.code === "ENOENT";

        if (!sourceFolderMissing) {
            throw error;
        }

        await createWorkspaceFolder(targetParent, resourceFolder);
    }

    try {
        const [updated] = await db
            .update(resources)
            .set({ groupName: null, sortOrder: null, workspaceId: targetWorkspace.id })
            .where(
                and(
                    eq(resources.id, resourceId),
                    eq(resources.workspaceId, record.sourceWorkspaceId),
                ),
            )
            .returning();

        if (!updated) {
            throw new Error("Resource changed while it was being moved");
        }

        return updated;
    } catch (error) {
        if (movedExistingFolder) {
            await fs.rename(targetFolder, sourceFolder);
        } else {
            await fs.rm(targetFolder, { force: true, recursive: true });
        }
        throw error;
    }
}

export async function updateResourceCompose(id: string, compose: string) {
    return await db
        .update(resources)
        .set({ value: compose })
        .where(eq(resources.id, id))
        .returning();
}

const updateIngressCompose = async (resourceId: string, update: (compose: string) => string) => {
    const resource = await getResource(resourceId);

    if (!resource) {
        throw new Error("Resource not found");
    }

    const compose = update(resource.value ?? "");
    const [updated] = await db
        .update(resources)
        .set({ value: compose })
        .where(eq(resources.id, resourceId))
        .returning();

    if (!updated) {
        throw new Error("Unable to update resource ingress");
    }

    return updated;
};

export const createResourceIngress = async (resourceId: string, route: ComposeIngressRouteInput) =>
    await updateIngressCompose(resourceId, (compose) => addComposeIngressRoute(compose, route));

export const updateResourceIngress = async (
    resourceId: string,
    routeId: string,
    route: ComposeIngressRouteInput,
) =>
    await updateIngressCompose(resourceId, (compose) =>
        updateComposeIngressRoute(compose, routeId, route),
    );

export const deleteResourceIngress = async (resourceId: string, routeId: string) =>
    await updateIngressCompose(resourceId, (compose) =>
        deleteComposeIngressRoute(compose, routeId),
    );

export async function deleteResource(id: string) {
    const [resource] = await db.select().from(resources).where(eq(resources.id, id));

    if (!resource) {
        throw new Error("Resource not found");
    }

    const [wrk] = await db.select().from(workspace).where(eq(workspace.id, resource.workspaceId));

    if (!wrk) {
        throw new Error("Workspace not found");
    }

    await deleteEnvironmentVariablesForResource(id);

    const op = await db.delete(resources).where(eq(resources.id, id)).returning();

    await fs.rm(path.join(workspacePath(wrk.id), wrk.slug, resource.slug ?? resource.id), {
        force: true,
        recursive: true,
    });

    return op;
}

export async function updateResourceIdentity(
    resourceId: string,
    patch: { icon?: string | null; name?: string },
) {
    const [resource] = await db.select().from(resources).where(eq(resources.id, resourceId));

    if (!resource) {
        throw new Error("Resource not found");
    }

    const next: { icon?: string | null; name?: string } = {};

    if (patch.name !== undefined) {
        next.name = normalizeResourceName(patch.name);
    }

    if (patch.icon !== undefined) {
        next.icon = normalizeResourceIcon(patch.icon);
    }

    if (next.name === undefined && next.icon === undefined) {
        return resource;
    }

    const [updated] = await db
        .update(resources)
        .set(next)
        .where(eq(resources.id, resourceId))
        .returning();

    if (!updated) {
        throw new Error("Unable to update resource");
    }

    return updated;
}

export async function updateResourceSettings(resourceId: string, settings: ResourceSettings) {
    const [resource] = await db.select().from(resources).where(eq(resources.id, resourceId));

    if (!resource) {
        throw new Error("Resource not found");
    }

    const [updated] = await db
        .update(resources)
        .set({
            settings: mergeResourceSettings(resource.settings, settings),
        })
        .where(eq(resources.id, resourceId))
        .returning();

    if (!updated) {
        throw new Error("Unable to update resource settings");
    }

    return updated;
}

export function resourceComposePrefix(resource: {
    id: string;
    settings?: unknown;
    slug: string | null;
}): string | undefined {
    if (!shouldPrefixResources(parseResourceSettings(resource.settings))) {
        return undefined;
    }

    return resource.slug ?? resource.id;
}

export async function getFormattedResourceCompose(resourceId: string) {
    const resource = await getResource(resourceId);

    if (!resource?.value) {
        throw new Error("the compose is invalid");
    }

    return formatComposeFile(resource.value, resourceComposePrefix(resource));
}

export async function previewResourceCompose(resourceId: string, compose: string) {
    const resource = await getResource(resourceId);

    if (!resource) {
        throw new Error("Resource not found");
    }

    return formatComposeFile(compose, resourceComposePrefix(resource));
}
