import { getLatestSuccessfulDeployment, listDeployments } from "#lib/api/deployments.remote";
import { listResourceFiles } from "#lib/api/resource-files.remote";
import {
    getPostgresConnection,
    getResource,
    listEnvironmentVariables,
    listResourceContainers,
    listResourceIngresses,
    listResourcesInWorkspace,
    streamResourceContainerLogs,
} from "#lib/api/resources.remote";

type RefreshableResourceQuery =
    | ReturnType<typeof getLatestSuccessfulDeployment>
    | ReturnType<typeof getPostgresConnection>
    | ReturnType<typeof getResource>
    | ReturnType<typeof listEnvironmentVariables>
    | ReturnType<typeof listResourceContainers>
    | ReturnType<typeof listResourceFiles>
    | ReturnType<typeof listResourceIngresses>
    | ReturnType<typeof listResourcesInWorkspace>;

type ReconnectableResourceQuery =
    | ReturnType<typeof listDeployments>
    | ReturnType<typeof streamResourceContainerLogs>;

const getResourceQueries = (
    resourceId: string,
    workspaceId?: string,
): RefreshableResourceQuery[] => {
    const queries: RefreshableResourceQuery[] = [
        getLatestSuccessfulDeployment(resourceId),
        getPostgresConnection(resourceId),
        getResource(resourceId),
        listEnvironmentVariables(resourceId),
        listResourceContainers(resourceId),
        listResourceFiles(resourceId),
        listResourceIngresses(resourceId),
    ];

    if (workspaceId) {
        queries.push(listResourcesInWorkspace(workspaceId));
    }

    return queries;
};

const getResourceLiveQueries = (resourceId: string): ReconnectableResourceQuery[] => [
    listDeployments(resourceId),
    streamResourceContainerLogs(resourceId),
];

/** Refreshes every client-side remote query associated with a resource. */
export const invalidateResource = async (
    resourceId: string,
    workspaceId?: string,
): Promise<void> => {
    await Promise.all([
        ...getResourceQueries(resourceId, workspaceId).map((query) => query.refresh()),
        ...getResourceLiveQueries(resourceId).map((query) => query.reconnect()),
    ]);
};
