import { getLatestSuccessfulDeployment, listDeployments } from "#lib/api/deployments.remote";
import {
    getPostgresConnection,
    getService,
    listEnvironmentVariables,
    listServiceContainers,
    listServiceIngresses,
    listServicesInWorkspace,
    streamServiceContainerLogs,
} from "#lib/api/services.remote";

type RefreshableServiceQuery =
    | ReturnType<typeof getLatestSuccessfulDeployment>
    | ReturnType<typeof getPostgresConnection>
    | ReturnType<typeof getService>
    | ReturnType<typeof listEnvironmentVariables>
    | ReturnType<typeof listServiceContainers>
    | ReturnType<typeof listServiceIngresses>
    | ReturnType<typeof listServicesInWorkspace>;

type ReconnectableServiceQuery =
    | ReturnType<typeof listDeployments>
    | ReturnType<typeof streamServiceContainerLogs>;

const getServiceQueries = (serviceId: string, workspaceId?: string): RefreshableServiceQuery[] => {
    const queries: RefreshableServiceQuery[] = [
        getLatestSuccessfulDeployment(serviceId),
        getPostgresConnection(serviceId),
        getService(serviceId),
        listEnvironmentVariables(serviceId),
        listServiceContainers(serviceId),
        listServiceIngresses(serviceId),
    ];

    if (workspaceId) {
        queries.push(listServicesInWorkspace(workspaceId));
    }

    return queries;
};

const getServiceLiveQueries = (serviceId: string): ReconnectableServiceQuery[] => [
    listDeployments(serviceId),
    streamServiceContainerLogs(serviceId),
];

/** Refreshes every client-side remote query associated with a service. */
export const invalidateService = async (serviceId: string, workspaceId?: string): Promise<void> => {
    await Promise.all([
        ...getServiceQueries(serviceId, workspaceId).map((query) => query.refresh()),
        ...getServiceLiveQueries(serviceId).map((query) => query.reconnect()),
    ]);
};
