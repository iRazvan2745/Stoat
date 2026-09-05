import { eq } from "drizzle-orm";

import { db } from "#lib/db";
import { gitSource } from "#lib/db/schema";
import { syncGitSource as syncGitSourceRecord } from "#lib/server/git-sources/sync";

import { command, query } from "$app/server";
import { error } from "@sveltejs/kit";
import * as v from "valibot";

import { requireDataSourceAccess, requireGitSourceAccess, requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { CreateGitSourceInput, UpdateGitSourceInput } from "#lib/domain/data-sources";
import { getOrganizationIdForUser } from "#lib/server/access";
import {
    createDataSource as createDataSourceRecord,
    createGitSource as createGitSourceRecord,
    deleteDataSource as deleteDataSourceRecord,
    deleteGitSource as deleteGitSourceRecord,
    discoverDataSource as discoverDataSourceRecord,
    getGitSourceForOrganization,
    listDataSourcesForOrganization,
    listGitSourcesForOrganization,
    updateDataSource as updateDataSourceRecord,
    updateGitSource as updateGitSourceRecord,
} from "#lib/server/data-sources/data-sources";

const DataSourceIdInput = v.pipe(v.string(), v.trim(), v.minLength(1));

const CreateDataSourceInput = v.object({
    /** New clients choose an existing organization Git Source. */
    gitSourceId: v.optional(DataSourceIdInput),
    /** @deprecated Kept as a compatibility bridge for pre Git Source clients. */
    gitUrl: v.optional(v.string()),
    uncloudToken: v.optional(v.nullable(v.string())),
    uncloudUrl: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const UpdateDataSourceInput = v.object({
    gitSourceId: v.optional(v.nullable(DataSourceIdInput)),
    /** @deprecated Kept as a compatibility bridge for pre Git Source clients. */
    gitUrl: v.optional(v.string()),
    id: DataSourceIdInput,
    uncloudToken: v.optional(v.nullable(v.string())),
    uncloudUrl: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export const listGitSources = query(
    withRemoteLogging("dataSources.listGitSources", "query", async () => {
        const session = requireSession();
        const organizationId = await getOrganizationIdForUser(
            session.user.id,
            session.session.activeOrganizationId,
        );

        if (!organizationId) {
            error(403, "No organization membership");
        }

        return await listGitSourcesForOrganization(organizationId);
    }),
);

export const getGitSource = query(
    DataSourceIdInput,
    withRemoteLogging(
        "dataSources.getGitSource",
        "query",
        async (gitSourceId: string) => {
            const session = await requireGitSourceAccess(gitSourceId);
            const organizationId = await getOrganizationIdForUser(
                session.user.id,
                session.session.activeOrganizationId,
            );

            if (!organizationId) {
                error(403, "No organization membership");
            }

            return await getGitSourceForOrganization(gitSourceId, organizationId);
        },
        { inputKey: "gitSourceId" },
    ),
);

export const createGitSource = command(
    CreateGitSourceInput,
    withRemoteLogging(
        "dataSources.createGitSource",
        "command",
        async (input: v.InferOutput<typeof CreateGitSourceInput>) => {
            const session = requireSession();
            const organizationId = await getOrganizationIdForUser(
                session.user.id,
                session.session.activeOrganizationId,
            );

            if (!organizationId) {
                error(403, "No organization membership");
            }

            return await createGitSourceRecord({ ...input, organizationId });
        },
    ),
);

export const updateGitSource = command(
    UpdateGitSourceInput,
    withRemoteLogging(
        "dataSources.updateGitSource",
        "command",
        async (input: v.InferOutput<typeof UpdateGitSourceInput>) => {
            await requireGitSourceAccess(input.id);
            return await updateGitSourceRecord(input);
        },
    ),
);

export const deleteGitSource = command(
    DataSourceIdInput,
    withRemoteLogging(
        "dataSources.deleteGitSource",
        "command",
        async (gitSourceId: string) => {
            await requireGitSourceAccess(gitSourceId);
            return await deleteGitSourceRecord(gitSourceId);
        },
        { inputKey: "gitSourceId" },
    ),
);

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
        async (input: v.InferOutput<typeof CreateDataSourceInput>) => {
            const session = requireSession();
            const organizationId = await getOrganizationIdForUser(
                session.user.id,
                session.session.activeOrganizationId,
            );

            if (!organizationId) {
                error(403, "No organization membership");
            }

            return await createDataSourceRecord({ ...input, organizationId });
        },
    ),
);

export const updateDataSource = command(
    UpdateDataSourceInput,
    withRemoteLogging(
        "dataSources.updateDataSource",
        "command",
        async (input: v.InferOutput<typeof UpdateDataSourceInput>) => {
            await requireDataSourceAccess(input.id);
            return await updateDataSourceRecord(input);
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

const UpdateGitSourceSyncInput = v.object({ gitSourceId: DataSourceIdInput, enabled: v.boolean() });

export const syncGitSource = command(
    DataSourceIdInput,
    withRemoteLogging(
        "dataSources.syncGitSource",
        "command",
        async (gitSourceId: string) => {
            await requireGitSourceAccess(gitSourceId);
            try {
                return await syncGitSourceRecord(gitSourceId);
            } catch {
                error(
                    400,
                    "Git sync failed. Check repository access, connectivity, and history; no force-push was performed.",
                );
            }
        },
        { inputKey: "gitSourceId" },
    ),
);

export const updateGitSourceSync = command(
    UpdateGitSourceSyncInput,
    withRemoteLogging(
        "dataSources.updateGitSourceSync",
        "command",
        async ({ gitSourceId, enabled }: v.InferOutput<typeof UpdateGitSourceSyncInput>) => {
            await requireGitSourceAccess(gitSourceId);
            await db
                .update(gitSource)
                .set({ syncEnabled: enabled })
                .where(eq(gitSource.id, gitSourceId));
        },
    ),
);

const ResolveGitSourceSyncInput = v.object({
    gitSourceId: DataSourceIdInput,
    resolution: v.picklist(["app", "git"]),
});

export const resolveGitSourceSync = command(
    ResolveGitSourceSyncInput,
    withRemoteLogging(
        "dataSources.resolveGitSourceSync",
        "command",
        async ({ gitSourceId, resolution }: v.InferOutput<typeof ResolveGitSourceSyncInput>) => {
            await requireGitSourceAccess(gitSourceId);
            try {
                return await syncGitSourceRecord(gitSourceId, resolution);
            } catch {
                error(400, "Git sync failed. Check repository access, connectivity, and history.");
            }
        },
    ),
);
