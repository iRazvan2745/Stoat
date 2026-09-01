import { query } from "$app/server";
import { error as kitError } from "@sveltejs/kit";

import { requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { getOrganizationIdForUser } from "#lib/server/access";
import {
    listDataSourceConnectionsForOrganization,
    type OrganizationDataSourceConnection,
} from "#lib/server/data-sources/data-sources";
import { createUncloudClient } from "#lib/server/uncloud";

import type { components } from "../../../../schema";
import { loadClusterItems, type ClusterListResult } from "./response";

type Service = components["schemas"]["Service"];

export type OrganizationService = Service & {
    dataSourceId: string;
};

const loadDataSourceServices = async (
    source: OrganizationDataSourceConnection,
): Promise<ClusterListResult<OrganizationService>> => {
    const result = await loadClusterItems("services", () =>
        createUncloudClient({
            uncloudToken: source.uncloudToken,
            uncloudUrl: source.uncloudUrl,
        }).GET("/api/v1/services"),
    );

    return {
        error: result.error,
        items: result.items.map((service) => ({
            ...service,
            dataSourceId: source.id,
        })),
    };
};

export const listServices = query(
    withRemoteLogging("cluster.listServices", "query", async () => {
        const session = requireSession();
        const organizationId = await getOrganizationIdForUser(
            session.user.id,
            session.session.activeOrganizationId,
        );

        if (!organizationId) {
            kitError(403, "No organization membership");
        }

        const sources = await listDataSourceConnectionsForOrganization(organizationId);
        const results = await Promise.all(sources.map((source) => loadDataSourceServices(source)));
        const items = results.flatMap((result) => result.items);
        const error =
            items.length === 0 ? (results.find((result) => result.error)?.error ?? null) : null;

        return { error, items };
    }),
);
