import { asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import {
    dataSource,
    environmentVariables,
    gitSource,
    resourceFiles,
    resources,
    workspace,
    workspaceEnvironmentVariables,
} from "#lib/db/schema";
import { mergeEnvironmentVariables } from "#lib/domain/environment";
import { parseResourceSettings } from "#lib/domain/resources/settings";

/** A config file carried in a deployment snapshot (DB source of truth or Git fallback). */
export interface SnapshotConfigFile {
    content: string;
    path: string;
}

/** Server-only: contains environment secrets and destination credentials. */
export interface DeploymentSnapshot {
    gitCommit?: string;
    gitCompose?: string;
    /** Sibling files read from the deployed Git commit (fallback when DB has no row). */
    gitFiles?: SnapshotConfigFile[];
    gitValidationError?: string;
    // Keep this payload JSON-native. The queue encodes it as JSON, so database
    // timestamps from full Drizzle rows would make enqueue fail (and are not
    // needed while preparing a deployment).
    resource: Pick<
        typeof resources.$inferSelect,
        | "groupName"
        | "icon"
        | "id"
        | "name"
        | "settings"
        | "slug"
        | "type"
        | "value"
        | "workspaceId"
    >;
    source: Pick<
        typeof dataSource.$inferSelect,
        "id" | "organizationId" | "gitSourceId" | "uncloudToken" | "uncloudUrl"
    >;
    git: Pick<
        typeof gitSource.$inferSelect,
        | "authMethod"
        | "id"
        | "name"
        | "organizationId"
        | "password"
        | "sshKnownHosts"
        | "sshPassphrase"
        | "sshPrivateKey"
        | "token"
        | "url"
        | "username"
    >;
    workspace: Pick<
        typeof workspace.$inferSelect,
        "dataSourceId" | "id" | "name" | "organizationId" | "slug"
    >;
    environment: { name: string; value: string }[];
    /** DB resource files: the source of truth for compose `configs:` content. */
    resourceFiles: SnapshotConfigFile[];
}

type DeploymentSnapshotRecord = Omit<DeploymentSnapshot, "environment" | "resourceFiles">;

/** Copy the rows captured in one transaction into a queue-safe snapshot. */
export const createDeploymentSnapshot = (
    record: DeploymentSnapshotRecord,
    environment: DeploymentSnapshot["environment"],
    files: readonly SnapshotConfigFile[] = [],
): DeploymentSnapshot => ({
    environment: environment.map(({ name, value }) => ({ name, value })),
    git: { ...record.git },
    ...(record.gitFiles
        ? { gitFiles: record.gitFiles.map(({ content, path }) => ({ content, path })) }
        : {}),
    resource: {
        ...record.resource,
        settings: parseResourceSettings(record.resource.settings),
    },
    resourceFiles: files.map(({ content, path }) => ({ content, path })),
    source: { ...record.source },
    workspace: { ...record.workspace },
});

export const captureDeploymentSnapshot = async (resourceId: string): Promise<DeploymentSnapshot> =>
    await db.transaction(
        async (tx) => {
            const [record] = await tx
                .select({
                    git: {
                        authMethod: gitSource.authMethod,
                        id: gitSource.id,
                        name: gitSource.name,
                        organizationId: gitSource.organizationId,
                        password: gitSource.password,
                        sshKnownHosts: gitSource.sshKnownHosts,
                        sshPassphrase: gitSource.sshPassphrase,
                        sshPrivateKey: gitSource.sshPrivateKey,
                        token: gitSource.token,
                        url: gitSource.url,
                        username: gitSource.username,
                    },
                    resource: {
                        groupName: resources.groupName,
                        icon: resources.icon,
                        id: resources.id,
                        name: resources.name,
                        settings: resources.settings,
                        slug: resources.slug,
                        type: resources.type,
                        value: resources.value,
                        workspaceId: resources.workspaceId,
                    },
                    source: {
                        gitSourceId: dataSource.gitSourceId,
                        id: dataSource.id,
                        organizationId: dataSource.organizationId,
                        uncloudToken: dataSource.uncloudToken,
                        uncloudUrl: dataSource.uncloudUrl,
                    },
                    workspace: {
                        dataSourceId: workspace.dataSourceId,
                        id: workspace.id,
                        name: workspace.name,
                        organizationId: workspace.organizationId,
                        slug: workspace.slug,
                    },
                })
                .from(resources)
                .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
                .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
                .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
                .where(eq(resources.id, resourceId));
            if (!record?.resource.value) {
                throw new Error("Resource or valid compose configuration not found");
            }
            const resourceVars = await tx
                .select({
                    name: environmentVariables.name,
                    value: environmentVariables.value,
                })
                .from(environmentVariables)
                .where(eq(environmentVariables.resourceId, resourceId))
                .orderBy(asc(environmentVariables.name));
            const workspaceVars = await tx
                .select({
                    name: workspaceEnvironmentVariables.name,
                    value: workspaceEnvironmentVariables.value,
                })
                .from(workspaceEnvironmentVariables)
                .where(eq(workspaceEnvironmentVariables.workspaceId, record.workspace.id))
                .orderBy(asc(workspaceEnvironmentVariables.name));
            const files = await tx
                .select({
                    content: resourceFiles.content,
                    path: resourceFiles.path,
                })
                .from(resourceFiles)
                .where(eq(resourceFiles.resourceId, resourceId))
                .orderBy(asc(resourceFiles.path));
            return createDeploymentSnapshot(
                record,
                mergeEnvironmentVariables(workspaceVars, resourceVars),
                files,
            );
        },
        { accessMode: "read only", isolationLevel: "repeatable read" },
    );
