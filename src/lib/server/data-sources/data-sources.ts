// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";

import { and, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, gitSource, resources, workspace } from "#lib/db/schema";
import { GIT_AUTH_METHODS, gitSourceSummary } from "#lib/domain/data-sources";
import type {
    CreateGitSourceInputOutput,
    GitAuthMethod,
    GitSourceConnection,
    GitSourceSummary,
    UpdateGitSourceInputOutput,
} from "#lib/domain/data-sources";
import {
    composeServiceName,
    discoverComposeFiles,
    repositoryName,
} from "#lib/server/data-sources/discovery";
import { createWorkspaceFolder, workspacePath } from "#lib/server/data-sources/paths";
import { withGitRepo } from "#lib/server/shared/git";
import { gitAuthenticationFromSource, validateGitSource } from "#lib/server/shared/git-auth";
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

export interface OrganizationGitSource extends GitSourceSummary {
    syncEnabled: boolean;
    syncResult: import("#lib/domain/git-sync").GitSyncResult | null;
    organizationId: string;
}

export interface OrganizationDataSource {
    gitSource: OrganizationGitSource;
    gitSourceId: string;
    /** @deprecated Use `gitSource.url`; retained for existing clients. */
    gitUrl: string | null;
    id: string;
    organizationId: string;
    uncloudUrl: string;
}

export interface OrganizationDataSourceConnection
    extends OrganizationDataSource, UncloudDataSource {
    gitSource: GitSourceConnection & OrganizationGitSource;
}

export interface CreateDataSourceOptions {
    gitSourceId?: string | null;
    /** @deprecated A Git Source is preferred; this creates one for old clients. */
    gitUrl?: string | null;
    organizationId: string;
    uncloudToken?: string | null;
    uncloudUrl: string;
}

export interface UpdateDataSourceOptions {
    gitSourceId?: string | null;
    id: string;
    /** @deprecated A Git Source is preferred; this creates one for old clients. */
    gitUrl?: string | null;
    uncloudToken?: string | null;
    uncloudUrl: string;
}

export interface CreateGitSourceRecordInput extends CreateGitSourceInputOutput {
    organizationId: string;
}

export interface UpdateGitSourceRecordInput extends UpdateGitSourceInputOutput {}

type GitSourceRow = typeof gitSource.$inferSelect;

const toGitSourceConnection = (source: GitSourceRow): GitSourceConnection => ({
    ...source,
    authMethod: source.authMethod as GitAuthMethod,
    hasPassword: Boolean(source.password),
    hasPrivateKey: Boolean(source.sshPrivateKey),
    hasToken: Boolean(source.token),
    sshKnownHostsConfigured: Boolean(source.sshKnownHosts),
});

const toGitSourceSummary = (source: GitSourceRow): OrganizationGitSource => ({
    ...gitSourceSummary(toGitSourceConnection(source)),
    syncEnabled: source.syncEnabled,
    syncResult: source.syncResult,
    organizationId: source.organizationId,
});

const cleanSecret = (value: string | null | undefined): string | null | undefined => {
    if (value === undefined) {
        return undefined;
    }

    return value === "" ? null : value;
};

/**
 * Legacy data source clients used to submit a repository URL directly. Keep
 * that compatibility path subject to the same validation and credential
 * stripping as first-class Git Sources before it reaches Git or the database.
 */
const legacyGitSource = (
    gitUrl: string | null | undefined,
): { name: string; url: string | null } => {
    const rawUrl = gitUrl?.trim() || null;

    if (!rawUrl) {
        return { name: "Local Git Source", url: null };
    }

    const validated = validateGitSource({
        authentication: { method: "none" },
        url: rawUrl,
    });

    return { name: repositoryName(validated.url), url: validated.url };
};

const assertGitAuthMethod: (authMethod: string) => asserts authMethod is GitAuthMethod = (
    authMethod,
) => {
    if (!(GIT_AUTH_METHODS as readonly string[]).includes(authMethod)) {
        throw new Error(`Unsupported Git authentication method: ${authMethod}`);
    }
};

const getGitSourceRow = async (gitSourceId: string): Promise<GitSourceRow> => {
    const [source] = await db.select().from(gitSource).where(eq(gitSource.id, gitSourceId));

    if (!source) {
        throw new Error("Git Source not found");
    }

    return source;
};

export const getGitSourceForOrganization = async (
    gitSourceId: string,
    organizationId: string,
): Promise<OrganizationGitSource> => {
    const [source] = await db
        .select()
        .from(gitSource)
        .where(and(eq(gitSource.id, gitSourceId), eq(gitSource.organizationId, organizationId)));

    if (!source) {
        throw new Error("Git Source not found for organization");
    }

    return toGitSourceSummary(source);
};

export const getGitSourceConnection = async (gitSourceId: string): Promise<GitSourceConnection> =>
    toGitSourceConnection(await getGitSourceRow(gitSourceId));

export const listGitSourcesForOrganization = async (
    organizationId: string,
): Promise<OrganizationGitSource[]> => {
    const rows = await db
        .select()
        .from(gitSource)
        .where(eq(gitSource.organizationId, organizationId))
        .orderBy(gitSource.createdAt);

    return rows.toReversed().map(toGitSourceSummary);
};

export const createGitSource = async ({
    authMethod,
    name,
    organizationId,
    password,
    sshKnownHosts,
    sshPassphrase,
    sshPrivateKey,
    token,
    url,
    username,
}: CreateGitSourceRecordInput): Promise<OrganizationGitSource> => {
    assertGitAuthMethod(authMethod);
    const validated = validateGitSource({
        authentication: {
            knownHosts: sshKnownHosts,
            method: authMethod,
            passphrase: sshPassphrase,
            password,
            privateKey: sshPrivateKey,
            token,
            username,
        },
        url,
    });
    const { authentication } = validated;

    const [created] = await db
        .insert(gitSource)
        .values({
            authMethod,
            name: name.trim(),
            organizationId,
            password: authentication.method === "basic" ? (authentication.password ?? null) : null,
            sshKnownHosts:
                authentication.method === "ssh" ? (authentication.knownHosts ?? null) : null,
            sshPassphrase:
                authentication.method === "ssh" ? (authentication.passphrase ?? null) : null,
            sshPrivateKey:
                authentication.method === "ssh" ? (authentication.privateKey ?? null) : null,
            token: authentication.method === "token" ? (authentication.token ?? null) : null,
            url: validated.url,
            username: authentication.method === "none" ? null : (authentication.username ?? null),
        })
        .returning();

    if (!created) {
        throw new Error("Unable to create Git Source");
    }

    return toGitSourceSummary(created);
};

export const updateGitSource = async ({
    authMethod,
    id: gitSourceId,
    name,
    password,
    sshKnownHosts,
    sshPassphrase,
    sshPrivateKey,
    token,
    url,
    username,
}: UpdateGitSourceRecordInput): Promise<OrganizationGitSource> => {
    const existing = await getGitSourceRow(gitSourceId);
    const nextAuthMethod = authMethod ?? existing.authMethod;
    assertGitAuthMethod(nextAuthMethod);
    const validated = validateGitSource({
        authentication: {
            knownHosts: sshKnownHosts === undefined ? existing.sshKnownHosts : sshKnownHosts,
            method: nextAuthMethod,
            passphrase: sshPassphrase === undefined ? existing.sshPassphrase : sshPassphrase,
            password: password === undefined ? existing.password : password,
            privateKey: sshPrivateKey === undefined ? existing.sshPrivateKey : sshPrivateKey,
            token: token === undefined ? existing.token : token,
            username: username === undefined ? existing.username : username,
        },
        url: url ?? existing.url,
    });
    const { authentication } = validated;

    const [updated] = await db
        .update(gitSource)
        .set({
            authMethod: nextAuthMethod,
            ...(name === undefined ? {} : { name: name.trim() }),
            password: authentication.method === "basic" ? (authentication.password ?? null) : null,
            sshKnownHosts:
                authentication.method === "ssh" ? (authentication.knownHosts ?? null) : null,
            sshPassphrase:
                authentication.method === "ssh" ? (authentication.passphrase ?? null) : null,
            sshPrivateKey:
                authentication.method === "ssh" ? (authentication.privateKey ?? null) : null,
            token: authentication.method === "token" ? (authentication.token ?? null) : null,
            url: validated.url,
            username: authentication.method === "none" ? null : (authentication.username ?? null),
        })
        .where(eq(gitSource.id, gitSourceId))
        .returning();

    if (!updated) {
        throw new Error("Git Source not found");
    }

    return toGitSourceSummary(updated);
};

export const deleteGitSource = async (gitSourceId: string) => {
    const linkedDataSources = await db
        .select({ id: dataSource.id })
        .from(dataSource)
        .where(eq(dataSource.gitSourceId, gitSourceId));

    if (linkedDataSources.length > 0) {
        const noun = linkedDataSources.length === 1 ? "data source" : "data sources";
        throw new Error(
            `Git Source has ${linkedDataSources.length} linked ${noun}; reassign them before deleting the Git Source`,
        );
    }

    const [deleted] = await db.delete(gitSource).where(eq(gitSource.id, gitSourceId)).returning();

    if (!deleted) {
        throw new Error("Git Source not found");
    }

    return [toGitSourceSummary(deleted)];
};

export const getResourceDataSource = async (resourceId: string): Promise<UncloudDataSource> => {
    const [source] = await db
        .select({
            uncloudToken: dataSource.uncloudToken,
            uncloudUrl: dataSource.uncloudUrl,
        })
        .from(resources)
        .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
        .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
        .where(eq(resources.id, resourceId));

    if (!source) {
        throw new Error("Data source not found for resource");
    }

    return source;
};

const toOrganizationDataSource = ({
    git,
    source,
}: {
    git: GitSourceRow;
    source: typeof dataSource.$inferSelect;
}): OrganizationDataSource => {
    const summary = toGitSourceSummary(git);

    return {
        gitSource: summary,
        gitSourceId: git.id,
        gitUrl: git.url,
        id: source.id,
        organizationId: source.organizationId,
        uncloudUrl: source.uncloudUrl,
    };
};

const toOrganizationDataSourceConnection = ({
    git,
    source,
}: {
    git: GitSourceRow;
    source: typeof dataSource.$inferSelect;
}): OrganizationDataSourceConnection => ({
    ...toOrganizationDataSource({ git, source }),
    gitSource: {
        ...toGitSourceConnection(git),
        syncEnabled: git.syncEnabled,
        syncResult: git.syncResult,
        organizationId: source.organizationId,
    },
    uncloudToken: source.uncloudToken,
    uncloudUrl: source.uncloudUrl,
});

export const listDataSourcesForOrganization = async (
    organizationId: string,
): Promise<OrganizationDataSource[]> => {
    const rows = await db
        .select({ git: gitSource, source: dataSource })
        .from(dataSource)
        .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
        .where(eq(dataSource.organizationId, organizationId))
        .orderBy(dataSource.createdAt);

    return rows.toReversed().map(toOrganizationDataSource);
};

export const listDataSourceConnectionsForOrganization = async (
    organizationId: string,
): Promise<OrganizationDataSourceConnection[]> => {
    const rows = await db
        .select({ git: gitSource, source: dataSource })
        .from(dataSource)
        .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
        .where(eq(dataSource.organizationId, organizationId))
        .orderBy(dataSource.createdAt);

    return rows.toReversed().map(toOrganizationDataSourceConnection);
};

export const createDataSource = async ({
    gitSourceId,
    gitUrl,
    organizationId,
    uncloudToken,
    uncloudUrl,
}: CreateDataSourceOptions) => {
    const [created] = await db.transaction(async (tx) => {
        let assignedGitSourceId = gitSourceId?.trim() || null;

        if (assignedGitSourceId) {
            const [assignedSource] = await tx
                .select({ id: gitSource.id })
                .from(gitSource)
                .where(
                    and(
                        eq(gitSource.id, assignedGitSourceId),
                        eq(gitSource.organizationId, organizationId),
                    ),
                );

            if (!assignedSource) {
                throw new Error("Git Source not found for organization");
            }
        } else {
            // Keep old clients usable while ensuring every data source still
            // has a first-class Git Source assignment.
            const legacy = legacyGitSource(gitUrl);
            const [createdGitSource] = await tx
                .insert(gitSource)
                .values({
                    name: legacy.name,
                    organizationId,
                    url: legacy.url,
                })
                .returning({ id: gitSource.id });

            if (!createdGitSource) {
                throw new Error("Unable to create Git Source for data source");
            }

            assignedGitSourceId = createdGitSource.id;
        }

        return await tx
            .insert(dataSource)
            .values({
                gitSourceId: assignedGitSourceId,
                organizationId,
                uncloudToken: cleanSecret(uncloudToken) ?? null,
                uncloudUrl: normalizeUncloudUrl(uncloudUrl),
            })
            .returning();
    });

    if (!created) {
        throw new Error("Unable to create data source");
    }

    return created;
};

export const updateDataSource = async ({
    gitSourceId,
    gitUrl,
    id,
    uncloudToken,
    uncloudUrl,
}: UpdateDataSourceOptions) => {
    const [updated] = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(dataSource).where(eq(dataSource.id, id));

        if (!existing) {
            throw new Error("Data source not found");
        }

        let assignedGitSourceId = gitSourceId === undefined ? existing.gitSourceId : gitSourceId;

        if (assignedGitSourceId === null || assignedGitSourceId.trim() === "") {
            const legacy = legacyGitSource(gitUrl);
            const [createdGitSource] = await tx
                .insert(gitSource)
                .values({
                    name: legacy.name,
                    organizationId: existing.organizationId,
                    url: legacy.url,
                })
                .returning({ id: gitSource.id });

            if (!createdGitSource) {
                throw new Error("Unable to create Git Source for data source");
            }

            assignedGitSourceId = createdGitSource.id;
        } else {
            const [assignedSource] = await tx
                .select({ id: gitSource.id })
                .from(gitSource)
                .where(
                    and(
                        eq(gitSource.id, assignedGitSourceId),
                        eq(gitSource.organizationId, existing.organizationId),
                    ),
                );

            if (!assignedSource) {
                throw new Error("Git Source not found for organization");
            }

            // Legacy clients can still replace their URL. Keep that operation
            // isolated in a new source rather than mutating a source shared by
            // other data sources.
            if (gitUrl !== undefined) {
                const legacy = legacyGitSource(gitUrl);
                const [createdGitSource] = await tx
                    .insert(gitSource)
                    .values({
                        name: legacy.name,
                        organizationId: existing.organizationId,
                        url: legacy.url,
                    })
                    .returning({ id: gitSource.id });

                if (!createdGitSource) {
                    throw new Error("Unable to create Git Source for data source");
                }

                assignedGitSourceId = createdGitSource.id;
            }
        }

        return await tx
            .update(dataSource)
            .set({
                gitSourceId: assignedGitSourceId,
                ...(uncloudToken === undefined
                    ? {}
                    : { uncloudToken: cleanSecret(uncloudToken) ?? null }),
                uncloudUrl: normalizeUncloudUrl(uncloudUrl),
            })
            .where(eq(dataSource.id, id))
            .returning();
    });

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
    const [source] = await db
        .select({ git: gitSource, source: dataSource })
        .from(dataSource)
        .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
        .where(eq(dataSource.id, id));

    if (!source) {
        throw new Error("Data source not found");
    }

    if (!source.git.url) {
        throw new Error("Data source has no Git URL");
    }

    const name = repositoryName(source.git.url);

    const [foundWorkspace] = await db
        .select()
        .from(workspace)
        .where(
            and(
                eq(workspace.dataSourceId, source.source.id),
                eq(workspace.name, name),
                eq(workspace.organizationId, source.source.organizationId),
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
                dataSourceId: source.source.id,
                name,
                organizationId: source.source.organizationId,
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
    await withGitRepo(
        {
            authentication: gitAuthenticationFromSource(source.git),
            repoPath,
            repoUrl: source.git.url,
        },
        async () => {},
    );

    const discovery = await discoverComposeFiles(repoPath);

    if (discovery.files.length === 0) {
        // Roll back a workspace that was only created for this discovery run.
        if (createdWorkspaceId) {
            await db.delete(workspace).where(eq(workspace.id, createdWorkspaceId));
            await fs.rm(repoPath, { force: true, recursive: true });
        }

        return {
            dataSourceId: source.source.id,
            discovered: 0,
            existing: 0,
            imported: 0,
            repositoryName: name,
            skipped: discovery.skipped.length,
            workspaceId: null,
        };
    }

    const linkedResources = await db
        .select({
            resource: resources,
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
        })
        .from(resources)
        .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
        .where(eq(workspace.dataSourceId, source.source.id));
    const generatedComposePaths = new Set(
        linkedResources.flatMap(({ resource, workspaceId, workspaceSlug }) => [
            `${workspaceSlug}/${resource.slug ?? resource.id}/compose.yaml`,
            `${workspaceId}/${resource.slug ?? resource.id}/compose.yaml`,
        ]),
    );
    const importedSourcePaths = new Set(
        linkedResources.flatMap(({ resource }) =>
            resource.settings?.sourcePath ? [resource.settings.sourcePath] : [],
        ),
    );

    let existing = 0;
    let imported = 0;

    for (const file of discovery.files) {
        if (generatedComposePaths.has(file.relativePath)) {
            continue;
        }

        if (importedSourcePaths.has(file.relativePath)) {
            existing += 1;
            continue;
        }

        const resourceName = composeServiceName(file.relativePath);
        const slug = await uniqueSlug(resourceName, async (candidate) => {
            const matches = await db
                .select({ slug: resources.slug })
                .from(resources)
                .where(eq(resources.slug, candidate));

            return matches.length > 0;
        });
        const [createdResource] = await db
            .insert(resources)
            .values({
                name: resourceName,
                settings: {
                    shouldPrefix: false,
                    sourcePath: file.relativePath,
                },
                slug,
                type: "compose",
                value: file.compose,
                workspaceId: targetWorkspace.id,
            })
            .returning();

        if (!createdResource) {
            throw new Error(`Unable to import ${file.relativePath}`);
        }

        await createWorkspaceFolder(repoPath, targetWorkspace.slug, createdResource.slug ?? slug);
        importedSourcePaths.add(file.relativePath);
        imported += 1;
    }

    return {
        dataSourceId: source.source.id,
        discovered: discovery.files.length,
        existing,
        imported,
        repositoryName: name,
        skipped: discovery.skipped.length,
        workspaceId: targetWorkspace.id,
    };
};
