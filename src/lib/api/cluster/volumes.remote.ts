import { query } from "$app/server";
import { error as kitError } from "@sveltejs/kit";

import { requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { getOrganizationIdForUser } from "#lib/server/access";
import { listDataSourceConnectionsForOrganization } from "#lib/server/data-sources/data-sources";
import type { OrganizationDataSourceConnection } from "#lib/server/data-sources/data-sources";
import { createUncloudClient } from "#lib/server/uncloud";

import type { components } from "../../../../schema";
import { loadClusterItems } from "./response";
import type { ClusterListResult } from "./response";

type Volume = components["schemas"]["Volume"];

export type OrganizationVolume = Volume & {
    dataSourceId: string;
};

const loadDataSourceVolumes = async (
    source: OrganizationDataSourceConnection,
): Promise<ClusterListResult<OrganizationVolume>> => {
    const result = await loadClusterItems("volumes", () =>
        createUncloudClient({
            uncloudToken: source.uncloudToken,
            uncloudUrl: source.uncloudUrl,
        }).GET("/api/v1/volumes"),
    );

    return {
        error: result.error,
        items: result.items.map((volume) => ({
            ...volume,
            dataSourceId: source.id,
        })),
    };
};

export const listVolumes = query(
    withRemoteLogging("cluster.listVolumes", "query", async () => {
        const session = requireSession();
        const organizationId = await getOrganizationIdForUser(
            session.user.id,
            session.session.activeOrganizationId,
        );

        if (!organizationId) {
            kitError(403, "No organization membership");
        }

        const sources = await listDataSourceConnectionsForOrganization(organizationId);
        const results = await Promise.all(sources.map((source) => loadDataSourceVolumes(source)));
        const items = results.flatMap((result) => result.items);
        const error =
            items.length === 0 ? (results.find((result) => result.error)?.error ?? null) : null;

        return { error, items };
    }),
);
