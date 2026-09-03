// oxlint-disable func-style
import fs from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { services, workspace } from "#lib/db/schema";
import type { EnvironmentVariable } from "#lib/domain/environment";
import { normalizeServiceIcon } from "#lib/domain/services/icon";
import { normalizeServiceName } from "#lib/domain/services/identity";
import type { ServiceSettings } from "#lib/domain/services/settings";
import {
    mergeServiceSettings,
    parseServiceSettings,
    shouldPrefixServices,
} from "#lib/domain/services/settings";
import { expandTemplateSecrets, expandTemplateVariables } from "#lib/domain/templates";
import { createWorkspaceFolder, workspacePath } from "#lib/server/data-sources/paths";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import {
    deleteEnvironmentVariablesForService,
    replaceEnvironmentVariables,
} from "#lib/server/services/service-environment";
import { uniqueSlug } from "#lib/server/shared/slugs";
import { readTemplateIconValue, readTemplateVersion } from "#lib/server/templates";

export interface CreateServiceInput {
    icon?: string;
    name: string;
    type: string;
    value: string;
    variables: readonly EnvironmentVariable[];
    workspaceId: string;
}

export async function getService(id: string) {
    const [op] = await db.select().from(services).where(eq(services.id, id));

    return op;
}

export async function listServicesInWorkspace(workspaceId: string) {
    return await db.select().from(services).where(eq(services.workspaceId, workspaceId));
}

export async function createService({
    icon,
    name,
    type,
    value,
    variables,
    workspaceId,
}: CreateServiceInput) {
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
            .select({ slug: services.slug })
            .from(services)
            .where(eq(services.slug, candidate));

        return matches.length > 0;
    });

    const [created] = await db
        .insert(services)
        .values({
            icon: normalizeServiceIcon(icon),
            name: normalizeServiceName(name),
            slug,
            type,
            value,
            workspaceId,
        })
        .returning();

    if (!created) {
        throw new Error("Unable to create service");
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
        await deleteEnvironmentVariablesForService(created.id);
        await db.delete(services).where(eq(services.id, created.id));
        throw error;
    }

    return created;
}

export async function createServiceFromTemplate({
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

    return await createService({
        icon: (await readTemplateIconValue(appId, template.manifest.icon)) ?? undefined,
        name,
        type: template.manifest.type,
        value: expandTemplateSecrets(template.compose),
        variables: expandTemplateVariables(template.variables),
        workspaceId,
    });
}

export async function copyService(serviceId: string, targetWorkspaceId: string) {
    const svc = await getService(serviceId);

    if (!svc) {
        throw new Error("Service not found");
    }

    if (svc.workspaceId === targetWorkspaceId) {
        throw new Error("Choose a different workspace for the copy");
    }

    return await createService({
        name: svc.name ?? "Copied service",
        type: "compose",
        value: svc.value ?? "",
        variables: [],
        workspaceId: targetWorkspaceId,
    });
}

export async function moveService(serviceId: string, targetWorkspaceId: string) {
    const [record] = await db
        .select({
            service: services,
            sourceDataSourceId: workspace.dataSourceId,
            sourceWorkspaceId: workspace.id,
            sourceWorkspaceSlug: workspace.slug,
        })
        .from(services)
        .innerJoin(workspace, eq(workspace.id, services.workspaceId))
        .where(eq(services.id, serviceId));

    if (!record) {
        throw new Error("Service not found");
    }

    if (record.sourceWorkspaceId === targetWorkspaceId) {
        throw new Error("Service is already in that workspace");
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
        throw new Error("Services can only move between workspaces using the same data source");
    }

    const serviceFolder = record.service.slug ?? record.service.id;
    const sourceFolder = path.join(
        workspacePath(record.sourceWorkspaceId),
        record.sourceWorkspaceSlug,
        serviceFolder,
    );
    const targetParent = await createWorkspaceFolder(
        workspacePath(targetWorkspace.id),
        targetWorkspace.slug,
    );
    const targetFolder = path.join(targetParent, serviceFolder);

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

        await createWorkspaceFolder(targetParent, serviceFolder);
    }

    try {
        const [updated] = await db
            .update(services)
            .set({ workspaceId: targetWorkspace.id })
            .where(
                and(eq(services.id, serviceId), eq(services.workspaceId, record.sourceWorkspaceId)),
            )
            .returning();

        if (!updated) {
            throw new Error("Service changed while it was being moved");
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

export async function updateServiceCompose(id: string, compose: string) {
    return await db.update(services).set({ value: compose }).where(eq(services.id, id)).returning();
}

export async function deleteService(id: string) {
    const [svc] = await db.select().from(services).where(eq(services.id, id));

    if (!svc) {
        throw new Error("Service not found");
    }

    const [wrk] = await db.select().from(workspace).where(eq(workspace.id, svc.workspaceId));

    if (!wrk) {
        throw new Error("Workspace not found");
    }

    await deleteEnvironmentVariablesForService(id);

    const op = await db.delete(services).where(eq(services.id, id)).returning();

    await fs.rm(path.join(workspacePath(wrk.id), wrk.slug, svc.slug ?? svc.id), {
        force: true,
        recursive: true,
    });

    return op;
}

export async function updateServiceIdentity(
    serviceId: string,
    patch: { icon?: string | null; name?: string },
) {
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));

    if (!svc) {
        throw new Error("Service not found");
    }

    const next: { icon?: string | null; name?: string } = {};

    if (patch.name !== undefined) {
        next.name = normalizeServiceName(patch.name);
    }

    if (patch.icon !== undefined) {
        next.icon = normalizeServiceIcon(patch.icon);
    }

    if (next.name === undefined && next.icon === undefined) {
        return svc;
    }

    const [updated] = await db
        .update(services)
        .set(next)
        .where(eq(services.id, serviceId))
        .returning();

    if (!updated) {
        throw new Error("Unable to update service");
    }

    return updated;
}

export async function updateServiceSettings(serviceId: string, settings: ServiceSettings) {
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));

    if (!svc) {
        throw new Error("Service not found");
    }

    const [updated] = await db
        .update(services)
        .set({
            settings: mergeServiceSettings(svc.settings, settings),
        })
        .where(eq(services.id, serviceId))
        .returning();

    if (!updated) {
        throw new Error("Unable to update service settings");
    }

    return updated;
}

export function serviceComposePrefix(svc: {
    id: string;
    settings?: unknown;
    slug: string | null;
}): string | undefined {
    if (!shouldPrefixServices(parseServiceSettings(svc.settings))) {
        return undefined;
    }

    return svc.slug ?? svc.id;
}

export async function getFormattedCompose(serviceId: string) {
    const svc = await getService(serviceId);

    if (!svc?.value) {
        throw new Error("the compose is invalid");
    }

    return formatComposeFile(svc.value, serviceComposePrefix(svc));
}

export async function previewServiceCompose(serviceId: string, compose: string) {
    const svc = await getService(serviceId);

    if (!svc) {
        throw new Error("Service not found");
    }

    return formatComposeFile(compose, serviceComposePrefix(svc));
}
