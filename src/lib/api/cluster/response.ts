import { getRemoteLogger } from "#lib/api/remote-logging";

export interface ClusterListResult<Item> {
    error: string | null;
    items: Item[];
}

interface ClusterListResponse<Item> {
    data?: { items: Item[] };
    response: Response;
}

export const getHttpErrorMessage = async (response: Response): Promise<string> => {
    try {
        const payload: unknown = await response.clone().json();

        if (
            typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof payload.error === "string" &&
            payload.error.length > 0
        ) {
            return payload.error;
        }
    } catch {
        // Some proxies return an empty or non-JSON error body.
    }

    return `Uncloud API returned HTTP ${response.status}.`;
};

const getErrorMessage = (error: unknown, resourceName: string): string =>
    error instanceof Error && error.message ? error.message : `Unable to load ${resourceName}.`;

export const loadClusterItems = async <Item>(
    resourceName: string,
    request: () => Promise<ClusterListResponse<Item>>,
): Promise<ClusterListResult<Item>> => {
    try {
        const { data, response } = await request();

        if (!response.ok) {
            getRemoteLogger()?.warn("cluster.api_response_error", {
                cluster: { resource: resourceName },
                responseStatus: response.status,
            });
            return {
                error: `Uncloud API returned HTTP ${response.status}.`,
                items: [],
            };
        }

        if (!data) {
            getRemoteLogger()?.warn("cluster.empty_response", {
                cluster: { resource: resourceName },
                responseStatus: response.status,
            });
            return {
                error: "Uncloud API returned an empty response.",
                items: [],
            };
        }

        return { error: null, items: data.items };
    } catch (error) {
        getRemoteLogger()?.error(error instanceof Error ? error : String(error), {
            cluster: { resource: resourceName },
        });
        return { error: getErrorMessage(error, resourceName), items: [] };
    }
};
