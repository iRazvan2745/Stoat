import { asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, environmentVariables, gitSource, services, workspace } from "#lib/db/schema";
import { parseServiceSettings } from "#lib/domain/services/settings";

/** Server-only: contains environment secrets and destination credentials. */
export interface DeploymentSnapshot {
    gitCommit?: string;
    gitCompose?: string;
    gitValidationError?: string;
    // Keep this payload JSON-native. The queue encodes it as JSON, so database
    // timestamps from full Drizzle rows would make enqueue fail (and are not
    // needed while preparing a deployment).
    service: Pick<
        typeof services.$inferSelect,
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
}

type DeploymentSnapshotRecord = Omit<DeploymentSnapshot, "environment">;

/** Copy the rows captured in one transaction into a queue-safe snapshot. */
export const createDeploymentSnapshot = (
    record: DeploymentSnapshotRecord,
    environment: DeploymentSnapshot["environment"],
): DeploymentSnapshot => ({
    environment: environment.map(({ name, value }) => ({ name, value })),
    git: { ...record.git },
    service: {
        ...record.service,
        settings: parseServiceSettings(record.service.settings),
    },
    source: { ...record.source },
    workspace: { ...record.workspace },
});

export const captureDeploymentSnapshot = async (serviceId: string): Promise<DeploymentSnapshot> =>
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
                    service: {
                        groupName: services.groupName,
                        icon: services.icon,
                        id: services.id,
                        name: services.name,
                        settings: services.settings,
                        slug: services.slug,
                        type: services.type,
                        value: services.value,
                        workspaceId: services.workspaceId,
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
                .from(services)
                .innerJoin(workspace, eq(workspace.id, services.workspaceId))
                .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
                .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
                .where(eq(services.id, serviceId));
            if (!record?.service.value) {
                throw new Error("Service or valid compose configuration not found");
            }
            const environment = await tx
                .select({
                    name: environmentVariables.name,
                    value: environmentVariables.value,
                })
                .from(environmentVariables)
                .where(eq(environmentVariables.serviceId, serviceId))
                .orderBy(asc(environmentVariables.name));
            return createDeploymentSnapshot(record, environment);
        },
        { accessMode: "read only", isolationLevel: "repeatable read" },
    );
