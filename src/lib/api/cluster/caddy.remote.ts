import { query } from "$app/server";
import { error as kitError } from "@sveltejs/kit";

import { requireSession } from "#lib/api/guard";
import { getRemoteLogger, withRemoteLogging } from "#lib/api/remote-logging";
import { getOrganizationIdForUser } from "#lib/server/access";
import { listDataSourceConnectionsForOrganization } from "#lib/server/data-sources/data-sources";
import type { OrganizationDataSourceConnection } from "#lib/server/data-sources/data-sources";
import { createUncloudClient } from "#lib/server/uncloud";

import type { components } from "../../../../schema";
import { getHttpErrorMessage } from "./response";

type CaddyConfig = components["schemas"]["CaddyConfig"];
type DataSourceStatus = "connected" | "error";

export interface OrganizationCaddyDataSourceStatus {
    configCount: number;
    dataSourceId: string;
    drift: boolean;
    error: string | null;
    gitUrl: string | null;
    label: string;
    status: DataSourceStatus;
    uncloudUrl: string;
}

export interface OrganizationCaddyConfig {
    config: CaddyConfig;
    dataSourceId: string;
}

export interface OrganizationCaddyConfigsResult {
    dataSources: OrganizationCaddyDataSourceStatus[];
    items: OrganizationCaddyConfig[];
}

const dataSourceLabel = (source: OrganizationDataSourceConnection): string =>
    source.gitSource.name || source.uncloudUrl;

const getErrorMessage = (error: unknown, label: string): string =>
    error instanceof Error && error.message
        ? error.message
        : `Unable to load Caddy configurations from ${label}.`;

const loadDataSourceCaddyConfigs = async (
    source: OrganizationDataSourceConnection,
): Promise<{
    dataSource: OrganizationCaddyDataSourceStatus;
    items: OrganizationCaddyConfig[];
}> => {
    const label = dataSourceLabel(source);
    const baseDataSource = {
        dataSourceId: source.id,
        gitUrl: source.gitUrl,
        label,
        uncloudUrl: source.uncloudUrl,
    };

    try {
        const { data, response } = await createUncloudClient({
            uncloudToken: source.uncloudToken,
            uncloudUrl: source.uncloudUrl,
        }).GET("/api/v1/caddy/configs");

        if (!response.ok) {
            const message = await getHttpErrorMessage(response);
            getRemoteLogger()?.warn("cluster.data_source_response_error", {
                cluster: {
                    dataSourceId: source.id,
                    resource: "caddy-configs",
                },
                responseStatus: response.status,
            });
            return {
                dataSource: {
                    ...baseDataSource,
                    configCount: 0,
                    drift: false,
                    error: message,
                    status: "error",
                },
                items: [],
            };
        }

        if (!data) {
            getRemoteLogger()?.warn("cluster.data_source_empty_response", {
                cluster: {
                    dataSourceId: source.id,
                    resource: "caddy-configs",
                },
                responseStatus: response.status,
            });
            return {
                dataSource: {
                    ...baseDataSource,
                    configCount: 0,
                    drift: false,
                    error: "Uncloud API returned an empty response.",
                    status: "error",
                },
                items: [],
            };
        }

        return {
            dataSource: {
                ...baseDataSource,
                configCount: data.items.length,
                drift: data.drift,
                error: null,
                status: "connected",
            },
            items: data.items.map((config) => ({
                config,
                dataSourceId: source.id,
            })),
        };
    } catch (error) {
        getRemoteLogger()?.error(error instanceof Error ? error : String(error), {
            cluster: {
                dataSourceId: source.id,
                resource: "caddy-configs",
            },
        });
        return {
            dataSource: {
                ...baseDataSource,
                configCount: 0,
                drift: false,
                error: getErrorMessage(error, label),
                status: "error",
            },
            items: [],
        };
    }
};

export const listOrganizationCaddyConfigs = query(
    withRemoteLogging(
        "cluster.listOrganizationCaddyConfigs",
        "query",
        async (): Promise<OrganizationCaddyConfigsResult> => {
            const session = requireSession();
            const organizationId = await getOrganizationIdForUser(
                session.user.id,
                session.session.activeOrganizationId,
            );

            if (!organizationId) {
                kitError(403, "No organization membership");
            }

            const sources = await listDataSourceConnectionsForOrganization(organizationId);
            const results = await Promise.all(
                sources.map((source) => loadDataSourceCaddyConfigs(source)),
            );

            return {
                dataSources: results.map((result) => result.dataSource),
                items: results.flatMap((result) => result.items),
            };
        },
    ),
);
