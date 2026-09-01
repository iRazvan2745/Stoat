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

type Machine = components["schemas"]["Machine"];
type DataSourceStatus = "connected" | "error";

export interface OrganizationDataSourceStatus {
    dataSourceId: string;
    error: string | null;
    gitUrl: string | null;
    label: string;
    machineCount: number;
    status: DataSourceStatus;
    uncloudUrl: string;
}

export interface OrganizationMachine {
    dataSourceId: string;
    machine: Machine;
}

export interface OrganizationMachinesResult {
    dataSources: OrganizationDataSourceStatus[];
    items: OrganizationMachine[];
}

const dataSourceLabel = (source: OrganizationDataSourceConnection): string =>
    source.gitUrl ?? source.uncloudUrl;

const getErrorMessage = (error: unknown, label: string): string =>
    error instanceof Error && error.message
        ? error.message
        : `Unable to load machines from ${label}.`;

const loadDataSourceMachines = async (
    source: OrganizationDataSourceConnection,
): Promise<{
    dataSource: OrganizationDataSourceStatus;
    items: OrganizationMachine[];
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
        }).GET("/api/v1/machines");

        if (!response.ok) {
            const message = await getHttpErrorMessage(response);
            getRemoteLogger()?.warn("cluster.data_source_response_error", {
                cluster: {
                    dataSourceId: source.id,
                    resource: "machines",
                },
                responseStatus: response.status,
            });
            return {
                dataSource: {
                    ...baseDataSource,
                    error: message,
                    machineCount: 0,
                    status: "error",
                },
                items: [],
            };
        }

        if (!data) {
            getRemoteLogger()?.warn("cluster.data_source_empty_response", {
                cluster: {
                    dataSourceId: source.id,
                    resource: "machines",
                },
                responseStatus: response.status,
            });
            return {
                dataSource: {
                    ...baseDataSource,
                    error: "Uncloud API returned an empty response.",
                    machineCount: 0,
                    status: "error",
                },
                items: [],
            };
        }

        return {
            dataSource: {
                ...baseDataSource,
                error: null,
                machineCount: data.items.length,
                status: "connected",
            },
            items: data.items.map((machine) => ({
                dataSourceId: source.id,
                machine,
            })),
        };
    } catch (error) {
        getRemoteLogger()?.error(error instanceof Error ? error : String(error), {
            cluster: {
                dataSourceId: source.id,
                resource: "machines",
            },
        });
        return {
            dataSource: {
                ...baseDataSource,
                error: getErrorMessage(error, label),
                machineCount: 0,
                status: "error",
            },
            items: [],
        };
    }
};

export const listOrganizationMachines = query(
    withRemoteLogging(
        "cluster.listOrganizationMachines",
        "query",
        async (): Promise<OrganizationMachinesResult> => {
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
                sources.map((source) => loadDataSourceMachines(source)),
            );

            return {
                dataSources: results.map((result) => result.dataSource),
                items: results.flatMap((result) => result.items),
            };
        },
    ),
);
