// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";

import { and, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, services, workspace } from "#lib/db/schema";
import {
    composeServiceName,
    discoverComposeFiles,
    repositoryName,
} from "#lib/server/data-sources/discovery";
import { createWorkspaceFolder, workspacePath } from "#lib/server/data-sources/paths";
import { getRepo } from "#lib/server/shared/git";
import { uniqueSlug } from "#lib/server/shared/slugs";
import { normalizeUncloudUrl } from "#lib/server/uncloud";

export interface DataSourceDiscoveryResult {
    dataSourceId: string;
    discovered: number;
    existing: number;
    imported: number;
    repositoryName: string;
    skipped: number;
    workspaceId: string | null;
}

export interface UncloudDataSource {
    uncloudToken: string | null;
    uncloudUrl: string;
}

export interface OrganizationDataSource {
    gitUrl: string | null;
    id: string;
    organizationId: string;
    uncloudUrl: string;
}

export interface OrganizationDataSourceConnection
    extends OrganizationDataSource, UncloudDataSource {}

export const getServiceDataSource = async (serviceId: string): Promise<UncloudDataSource> => {
    const [source] = await db
        .select({
            uncloudToken: dataSource.uncloudToken,
            uncloudUrl: dataSource.uncloudUrl,
        })
        .from(services)
        .innerJoin(workspace, eq(workspace.id, services.workspaceId))
        .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
        .where(eq(services.id, serviceId));

    if (!source) {
        throw new Error("Data source not found for service");
    }

    return source;
};

const dataSourceListFields = {
    gitUrl: dataSource.gitUrl,
    id: dataSource.id,
    organizationId: dataSource.organizationId,
    uncloudUrl: dataSource.uncloudUrl,
};

export const listDataSourcesForOrganization = async (
    organizationId: string,
): Promise<OrganizationDataSource[]> => {
    const rows = await db
        .select(dataSourceListFields)
        .from(dataSource)
        .where(eq(dataSource.organizationId, organizationId))
        .orderBy(dataSource.createdAt);

    return rows.toReversed();
};

export const listDataSourceConnectionsForOrganization = async (
    organizationId: string,
): Promise<OrganizationDataSourceConnection[]> => {
    const rows = await db
        .select({
            ...dataSourceListFields,
            uncloudToken: dataSource.uncloudToken,
        })
        .from(dataSource)
        .where(eq(dataSource.organizationId, organizationId))
        .orderBy(dataSource.createdAt);

    return rows.toReversed();
};

export const createDataSource = async (
    gitUrl: string | null,
    uncloudUrl: string,
    organizationId: string,
) => {
    const [created] = await db
        .insert(dataSource)
        .values({
            gitUrl,
            organizationId,
            uncloudUrl: normalizeUncloudUrl(uncloudUrl),
        })
        .returning();

    if (!created) {
        throw new Error("Unable to create data source");
    }

    return created;
};

export const updateDataSource = async (id: string, gitUrl: string | null, uncloudUrl: string) => {
    const [updated] = await db
        .update(dataSource)
        .set({ gitUrl, uncloudUrl: normalizeUncloudUrl(uncloudUrl) })
        .where(eq(dataSource.id, id))
        .returning();

    if (!updated) {
        throw new Error("Data source not found");
    }

    return updated;
};

export const deleteDataSource = async (id: string) => {
    const linkedWorkspaces = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.dataSourceId, id));

    if (linkedWorkspaces.length > 0) {
        const noun = linkedWorkspaces.length === 1 ? "workspace" : "workspaces";
        throw new Error(
            `Data source has ${linkedWorkspaces.length} ${noun}; delete them before deleting the data source`,
        );
    }

    const [deleted] = await db.delete(dataSource).where(eq(dataSource.id, id)).returning();

    if (!deleted) {
        throw new Error("Data source not found");
    }

    return [deleted];
};

export const discoverDataSource = async (id: string): Promise<DataSourceDiscoveryResult> => {
    const [source] = await db.select().from(dataSource).where(eq(dataSource.id, id));

    if (!source) {
        throw new Error("Data source not found");
    }

    if (!source.gitUrl) {
        throw new Error("Data source has no Git URL");
    }

    const name = repositoryName(source.gitUrl);

    const [foundWorkspace] = await db
        .select()
        .from(workspace)
        .where(
            and(
                eq(workspace.dataSourceId, source.id),
                eq(workspace.name, name),
                eq(workspace.organizationId, source.organizationId),
            ),
        )
        .limit(1);

    let targetWorkspace = foundWorkspace;
    let createdWorkspaceId: string | null = null;

    if (!targetWorkspace) {
        const slug = await uniqueSlug(name, async (candidate) => {
            const matches = await db
                .select({ slug: workspace.slug })
                .from(workspace)
                .where(eq(workspace.slug, candidate));

            return matches.length > 0;
        });

        const [createdWorkspace] = await db
            .insert(workspace)
            .values({
                dataSourceId: source.id,
                name,
                organizationId: source.organizationId,
                slug,
            })
            .returning();

        if (!createdWorkspace) {
            throw new Error("Unable to create discovery workspace");
        }

        targetWorkspace = createdWorkspace;
        createdWorkspaceId = createdWorkspace.id;
    }

    const repoPath = workspacePath(targetWorkspace.id);
    await getRepo({ repoPath, repoUrl: source.gitUrl });

    const discovery = await discoverComposeFiles(repoPath);

    if (discovery.files.length === 0) {
        // Roll back a workspace that was only created for this discovery run.
        if (createdWorkspaceId) {
            await db.delete(workspace).where(eq(workspace.id, createdWorkspaceId));
            await fs.rm(repoPath, { force: true, recursive: true });
        }

        return {
            dataSourceId: source.id,
            discovered: 0,
            existing: 0,
            imported: 0,
            repositoryName: name,
            skipped: discovery.skipped.length,
            workspaceId: null,
        };
    }

    const existingServices = await db
        .select()
        .from(services)
        .where(eq(services.workspaceId, targetWorkspace.id));
    const generatedComposePaths = new Set(
        existingServices.flatMap((service) => [
            `${targetWorkspace.slug}/${service.slug}/compose.yaml`,
            `${targetWorkspace.id}/${service.slug}/compose.yaml`,
        ]),
    );

    let existing = 0;
    let imported = 0;

    for (const file of discovery.files) {
        if (generatedComposePaths.has(file.relativePath)) {
            continue;
        }

        const alreadyImported = existingServices.some(
            (service) => service.settings?.sourcePath === file.relativePath,
        );

        if (alreadyImported) {
            existing += 1;
            continue;
        }

        const serviceName = composeServiceName(file.relativePath);
        const slug = await uniqueSlug(serviceName, async (candidate) => {
            const matches = await db
                .select({ slug: services.slug })
                .from(services)
                .where(eq(services.slug, candidate));

            return matches.length > 0;
        });
        const [createdService] = await db
            .insert(services)
            .values({
                name: serviceName,
                settings: { sourcePath: file.relativePath },
                slug,
                type: "compose",
                value: file.compose,
                workspaceId: targetWorkspace.id,
            })
            .returning();

        if (!createdService) {
            throw new Error(`Unable to import ${file.relativePath}`);
        }

        await createWorkspaceFolder(repoPath, targetWorkspace.slug, createdService.slug ?? slug);
        existingServices.push(createdService);
        imported += 1;
    }

    return {
        dataSourceId: source.id,
        discovered: discovery.files.length,
        existing,
        imported,
        repositoryName: name,
        skipped: discovery.skipped.length,
        workspaceId: targetWorkspace.id,
    };
};
