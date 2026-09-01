import { command, query } from "$app/server";
import { error } from "@sveltejs/kit";
import * as v from "valibot";

import { requireDataSourceAccess, requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { getOrganizationIdForUser } from "#lib/server/access";
import {
    createDataSource as createDataSourceRecord,
    deleteDataSource as deleteDataSourceRecord,
    discoverDataSource as discoverDataSourceRecord,
    listDataSourcesForOrganization,
    updateDataSource as updateDataSourceRecord,
} from "#lib/server/data-sources/data-sources";

const CreateDataSourceInput = v.object({
    gitUrl: v.optional(v.string()),
    uncloudUrl: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const DataSourceIdInput = v.string();

const UpdateDataSourceInput = v.object({
    gitUrl: v.optional(v.string()),
    id: v.pipe(v.string(), v.minLength(1)),
    uncloudUrl: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export const listDataSources = query(
    withRemoteLogging("dataSources.listDataSources", "query", async () => {
        const session = requireSession();
        const organizationId = await getOrganizationIdForUser(
            session.user.id,
            session.session.activeOrganizationId,
        );

        if (!organizationId) {
            error(403, "No organization membership");
        }

        return await listDataSourcesForOrganization(organizationId);
    }),
);

export const createDataSource = command(
    CreateDataSourceInput,
    withRemoteLogging(
        "dataSources.createDataSource",
        "command",
        async ({ gitUrl, uncloudUrl }: { gitUrl?: string; uncloudUrl: string }) => {
            const session = requireSession();
            const organizationId = await getOrganizationIdForUser(
                session.user.id,
                session.session.activeOrganizationId,
            );

            if (!organizationId) {
                error(403, "No organization membership");
            }

            return await createDataSourceRecord(gitUrl?.trim() || null, uncloudUrl, organizationId);
        },
    ),
);

export const updateDataSource = command(
    UpdateDataSourceInput,
    withRemoteLogging(
        "dataSources.updateDataSource",
        "command",
        async ({
            gitUrl,
            id: dataSourceId,
            uncloudUrl,
        }: {
            gitUrl?: string;
            id: string;
            uncloudUrl: string;
        }) => {
            await requireDataSourceAccess(dataSourceId);

            return await updateDataSourceRecord(
                dataSourceId,
                gitUrl?.trim() || null,
                uncloudUrl.trim(),
            );
        },
    ),
);

export const discoverDataSource = command(
    DataSourceIdInput,
    withRemoteLogging(
        "dataSources.discoverDataSource",
        "command",
        async (dataSourceId: string) => {
            await requireDataSourceAccess(dataSourceId);
            return await discoverDataSourceRecord(dataSourceId);
        },
        { inputKey: "dataSourceId" },
    ),
);

export const deleteDataSource = command(
    DataSourceIdInput,
    withRemoteLogging(
        "dataSources.deleteDataSource",
        "command",
        async (dataSourceId: string) => {
            await requireDataSourceAccess(dataSourceId);
            return await deleteDataSourceRecord(dataSourceId);
        },
        { inputKey: "dataSourceId" },
    ),
);
