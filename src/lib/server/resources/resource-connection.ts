import {
    DEFAULT_POSTGRES_PORT,
    buildPostgresUrl,
    internalHostname,
    postgresConnectionParts,
} from "#lib/domain/resources/database-url";
import type { PostgresConnectionUrl } from "#lib/domain/resources/database-url";
import { mergeEnvironmentVariables } from "#lib/domain/environment";
import { getResourceDataSource } from "#lib/server/data-sources/data-sources";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
// oxlint-disable func-style
import { findPublishedTcpPort, listComposePorts } from "#lib/server/resources/compose-ports";
import { listEnvironmentVariables } from "#lib/server/resources/resource-environment";
import { listWorkspaceEnvironmentVariables } from "#lib/server/workspaces/environment";
import { getResource, resourceComposePrefix } from "#lib/server/resources/resources";
import { firstPublicHost } from "#lib/server/uncloud/public-host";

export interface PostgresConnectionInfo {
    database: string;
    external: PostgresConnectionUrl | null;
    internal: PostgresConnectionUrl;
    password: string;
    user: string;
}

const externalHost = async (
    resourceId: string,
    hostIp: string | undefined,
    hostname: string | undefined,
): Promise<string | undefined> => {
    const configuredHost = hostIp ?? hostname;

    if (configuredHost) {
        return configuredHost;
    }

    return await firstPublicHost(await getResourceDataSource(resourceId));
};

export async function getPostgresConnection(
    resourceId: string,
): Promise<PostgresConnectionInfo | null> {
    const resource = await getResource(resourceId);

    if (!resource || resource.type !== "postgresql") {
        return null;
    }

    const [workspaceVars, resourceVars] = await Promise.all([
        listWorkspaceEnvironmentVariables(resource.workspaceId),
        listEnvironmentVariables(resourceId),
    ]);
    const parts = postgresConnectionParts(mergeEnvironmentVariables(workspaceVars, resourceVars));
    const compose = resource.value ?? "";
    let formattedNames: string[] = [];

    if (resource.value) {
        try {
            formattedNames = formatComposeFile(
                resource.value,
                resourceComposePrefix(resource),
            ).serviceNames;
        } catch {
            formattedNames = [];
        }
    }

    const resourceName = formattedNames[0] ?? resource.slug ?? resource.id;
    const published = findPublishedTcpPort(listComposePorts(compose), DEFAULT_POSTGRES_PORT);
    const internalPort = published?.containerPort ?? DEFAULT_POSTGRES_PORT;
    const internal = {
        host: internalHostname(resourceName),
        port: internalPort,
        url: buildPostgresUrl(parts, {
            host: internalHostname(resourceName),
            port: internalPort,
        }),
    };

    if (published?.publishedPort === undefined) {
        return {
            database: parts.database,
            external: null,
            internal,
            password: parts.password,
            user: parts.user,
        };
    }

    const host = await externalHost(resourceId, published.hostIp, published.hostname);

    if (!host) {
        return {
            database: parts.database,
            external: null,
            internal,
            password: parts.password,
            user: parts.user,
        };
    }

    return {
        database: parts.database,
        external: {
            host,
            port: published.publishedPort,
            url: buildPostgresUrl(parts, {
                host,
                port: published.publishedPort,
            }),
        },
        internal,
        password: parts.password,
        user: parts.user,
    };
}
