import { command, query, requested } from "$app/server";
import * as v from "valibot";

import { requireResourceAccess } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { getResource } from "#lib/api/resources.remote";
import { ResourceFileInputSchema, ResourceFileUpdateSchema } from "#lib/domain/resources/files";
import {
    listResourceFiles as listResourceFileRecords,
    createResourceFile as createResourceFileRecord,
    deleteResourceFile as deleteResourceFileRecord,
    getResourceFile as getResourceFileRecord,
    listResourceConfigReferences as listResourceConfigReferenceRecords,
    updateResourceFile as updateResourceFileRecord,
} from "#lib/server/resources/resource-files";

const ResourceIdInput = v.string();

const GetResourceFileInput = v.object({
    fileId: v.string(),
    resourceId: ResourceIdInput,
});

const CreateResourceFileInput = v.object({
    ...ResourceFileInputSchema.entries,
    resourceId: ResourceIdInput,
});

const UpdateResourceFileInput = v.object({
    ...ResourceFileUpdateSchema.entries,
    fileId: v.string(),
    resourceId: ResourceIdInput,
});

const DeleteResourceFileInput = v.object({
    fileId: v.string(),
    resourceId: ResourceIdInput,
});

// Queries
export const listResourceFiles = query(
    ResourceIdInput,
    withRemoteLogging(
        "resourceFiles.listResourceFiles",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await listResourceFileRecords(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

export const getResourceFile = query(
    GetResourceFileInput,
    withRemoteLogging(
        "resourceFiles.getResourceFile",
        "query",
        async ({ fileId, resourceId }: v.InferOutput<typeof GetResourceFileInput>) => {
            await requireResourceAccess(resourceId);
            return await getResourceFileRecord(resourceId, fileId);
        },
    ),
);

export const listResourceConfigReferences = query(
    ResourceIdInput,
    withRemoteLogging(
        "resourceFiles.listResourceConfigReferences",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await listResourceConfigReferenceRecords(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

const RESOURCE_FILE_QUERY_REFRESH_LIMIT = 8;

const refreshResourceFileQueries = async (): Promise<void> => {
    await requested(listResourceFiles, RESOURCE_FILE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(getResourceFile, RESOURCE_FILE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listResourceConfigReferences, RESOURCE_FILE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(getResource, RESOURCE_FILE_QUERY_REFRESH_LIMIT).refreshAll();
};

// Commands
export const createResourceFile = command(
    CreateResourceFileInput,
    withRemoteLogging(
        "resourceFiles.createResourceFile",
        "command",
        async ({ content, path, resourceId }: v.InferOutput<typeof CreateResourceFileInput>) => {
            await requireResourceAccess(resourceId);
            const created = await createResourceFileRecord(resourceId, {
                content,
                path,
            });
            await refreshResourceFileQueries();
            return created;
        },
    ),
);

export const updateResourceFile = command(
    UpdateResourceFileInput,
    withRemoteLogging(
        "resourceFiles.updateResourceFile",
        "command",
        async ({
            content,
            fileId,
            path,
            resourceId,
        }: v.InferOutput<typeof UpdateResourceFileInput>) => {
            await requireResourceAccess(resourceId);
            const updated = await updateResourceFileRecord(resourceId, fileId, {
                content,
                path,
            });
            await refreshResourceFileQueries();
            return updated;
        },
    ),
);

export const deleteResourceFile = command(
    DeleteResourceFileInput,
    withRemoteLogging(
        "resourceFiles.deleteResourceFile",
        "command",
        async ({ fileId, resourceId }: v.InferOutput<typeof DeleteResourceFileInput>) => {
            await requireResourceAccess(resourceId);
            const deleted = await deleteResourceFileRecord(resourceId, fileId);
            await refreshResourceFileQueries();
            return deleted;
        },
    ),
);
