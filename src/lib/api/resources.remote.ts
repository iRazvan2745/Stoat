import { command, getRequestEvent, query, requested } from "$app/server";
import * as v from "valibot";

import { requireResourceAccess, requireWorkspaceAccess } from "#lib/api/guard";
import { withRemoteLiveLogging, withRemoteLogging } from "#lib/api/remote-logging";
import { ENV_NAME_PATTERN } from "#lib/domain/environment";
import { MAX_RESOURCE_NAME_LENGTH } from "#lib/domain/resources/identity";
import { ResourceSettingsSchema } from "#lib/domain/resources/settings";
import { deployResource as deployResourceRecord } from "#lib/server/deployments/deployments";
import { getPostgresConnection as getPostgresConnectionRecord } from "#lib/server/resources/resource-connection";
import { listResourceContainers as listResourceContainerRecords } from "#lib/server/resources/resource-containers";
import {
    listEnvironmentVariables as listResourceEnvironmentVariables,
    replaceEnvironmentVariables,
} from "#lib/server/resources/resource-environment";
import { listResourceIngresses as listResourceIngressRecords } from "#lib/server/resources/resource-ingresses";
import { streamResourceContainerLogs as streamResourceContainerLogsFromServer } from "#lib/server/resources/resource-logs";
import {
    createResourceFromTemplate as createResourceFromTemplateRecord,
    createResourceIngress as createResourceIngressRecord,
    createResource as createResourceRecord,
    copyResource as copyResourceRecord,
    deleteResourceIngress as deleteResourceIngressRecord,
    deleteResource as deleteResourceRecord,
    getResource as getResourceRecord,
    listResourcesInWorkspace as listResourcesInWorkspaceRecords,
    moveResource as moveResourceRecord,
    previewResourceCompose as previewResourceComposeRecord,
    updateResourceCompose as updateResourceComposeRecord,
    updateResourceIngress as updateResourceIngressRecord,
    updateResourceIdentity as updateResourceIdentityRecord,
    updateResourceSettings as updateResourceSettingsRecord,
} from "#lib/server/resources/resources";
import { isAbortError } from "#lib/server/shared/sse";

const ResourceIdInput = v.string();
const WorkspaceIdInput = v.string();

const EnvironmentVariableInput = v.object({
    name: v.pipe(v.string(), v.regex(ENV_NAME_PATTERN)),
    value: v.string(),
});

const CreateResourceInput = v.object({
    icon: v.optional(v.string()),
    name: v.pipe(v.string(), v.minLength(1)),
    type: v.optional(v.string(), "compose"),
    value: v.optional(v.string(), ""),
    variables: v.optional(v.array(EnvironmentVariableInput), []),
    workspaceId: WorkspaceIdInput,
});

const CreateResourceFromTemplateInput = v.object({
    appId: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(1)),
    version: v.pipe(v.string(), v.minLength(1)),
    workspaceId: WorkspaceIdInput,
});

const UpdateResourceComposeInput = v.object({
    compose: v.string(),
    resourceId: ResourceIdInput,
});

const IngressRouteFieldsInput = {
    composeService: v.pipe(v.string(), v.trim(), v.minLength(1)),
    containerPort: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
    hostname: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(253))),
    protocol: v.picklist(["http", "https", "tcp", "udp"]),
    publishedPort: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))),
};

const CreateResourceIngressInput = v.object({
    ...IngressRouteFieldsInput,
    resourceId: ResourceIdInput,
});

const UpdateResourceIngressInput = v.object({
    ...IngressRouteFieldsInput,
    routeId: v.pipe(v.string(), v.minLength(1)),
    resourceId: ResourceIdInput,
});

const DeleteResourceIngressInput = v.object({
    routeId: v.pipe(v.string(), v.minLength(1)),
    resourceId: ResourceIdInput,
});

const TransferResourceInput = v.object({
    resourceId: ResourceIdInput,
    targetWorkspaceId: WorkspaceIdInput,
});

const UpdateResourceEnvironmentInput = v.pipe(
    v.object({
        resourceId: ResourceIdInput,
        variables: v.array(EnvironmentVariableInput),
    }),
    v.check(
        (input) =>
            new Set(input.variables.map((variable) => variable.name)).size ===
            input.variables.length,
        "Environment variable names must be unique",
    ),
);

const UpdateResourceIdentityInput = v.pipe(
    v.object({
        icon: v.optional(v.nullable(v.string())),
        name: v.optional(
            v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_RESOURCE_NAME_LENGTH)),
        ),
        resourceId: ResourceIdInput,
    }),
    v.check(
        (input) => input.icon !== undefined || input.name !== undefined,
        "Name or icon is required",
    ),
);

const UpdateResourceSettingsInput = v.object({
    resourceId: ResourceIdInput,
    settings: ResourceSettingsSchema,
});

// Queries
export const listResourcesInWorkspace = query(
    WorkspaceIdInput,
    withRemoteLogging(
        "resources.listResourcesInWorkspace",
        "query",
        async (workspaceId: string) => {
            await requireWorkspaceAccess(workspaceId);
            return await listResourcesInWorkspaceRecords(workspaceId);
        },
        { inputKey: "workspaceId" },
    ),
);

export const getResource = query(
    ResourceIdInput,
    withRemoteLogging(
        "resources.getResource",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await getResourceRecord(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

export const getPostgresConnection = query(
    ResourceIdInput,
    withRemoteLogging(
        "resources.getPostgresConnection",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await getPostgresConnectionRecord(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

export const listEnvironmentVariables = query(
    ResourceIdInput,
    withRemoteLogging(
        "resources.listEnvironmentVariables",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await listResourceEnvironmentVariables(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

export const listResourceContainers = query(
    ResourceIdInput,
    withRemoteLogging(
        "resources.listResourceContainers",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await listResourceContainerRecords(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

export const listResourceIngresses = query(
    ResourceIdInput,
    withRemoteLogging(
        "resources.listResourceIngresses",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await listResourceIngressRecords(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

// Live queries
const streamResourceContainerLogsRemote = async function* streamResourceContainerLogsRemote(
    resourceId: string,
) {
    await requireResourceAccess(resourceId);

    const { request } = getRequestEvent();

    try {
        yield* streamResourceContainerLogsFromServer(resourceId, request.signal);
    } catch (error) {
        if (isAbortError(error)) {
            return;
        }

        throw error;
    }
};

export const streamResourceContainerLogs = query.live(
    ResourceIdInput,
    withRemoteLiveLogging(
        "resources.streamResourceContainerLogs",
        streamResourceContainerLogsRemote,
        {
            inputKey: "resourceId",
        },
    ),
);

const RESOURCE_QUERY_REFRESH_LIMIT = 8;

const refreshResourceQueries = async (): Promise<void> => {
    await requested(getResource, RESOURCE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listResourceContainers, RESOURCE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(getPostgresConnection, RESOURCE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listEnvironmentVariables, RESOURCE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listResourcesInWorkspace, RESOURCE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listResourceIngresses, RESOURCE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(streamResourceContainerLogs, RESOURCE_QUERY_REFRESH_LIMIT).reconnectAll();
};

// Commands
export const createResourceIngress = command(
    CreateResourceIngressInput,
    withRemoteLogging(
        "resources.createResourceIngress",
        "command",
        async ({ resourceId, ...route }: v.InferOutput<typeof CreateResourceIngressInput>) => {
            await requireResourceAccess(resourceId);
            const updated = await createResourceIngressRecord(resourceId, route);
            await refreshResourceQueries();
            return updated;
        },
    ),
);

export const updateResourceIngress = command(
    UpdateResourceIngressInput,
    withRemoteLogging(
        "resources.updateResourceIngress",
        "command",
        async ({
            routeId,
            resourceId,
            ...route
        }: v.InferOutput<typeof UpdateResourceIngressInput>) => {
            await requireResourceAccess(resourceId);
            const updated = await updateResourceIngressRecord(resourceId, routeId, route);
            await refreshResourceQueries();
            return updated;
        },
    ),
);

export const deleteResourceIngress = command(
    DeleteResourceIngressInput,
    withRemoteLogging(
        "resources.deleteResourceIngress",
        "command",
        async ({ routeId, resourceId }: v.InferOutput<typeof DeleteResourceIngressInput>) => {
            await requireResourceAccess(resourceId);
            const updated = await deleteResourceIngressRecord(resourceId, routeId);
            await refreshResourceQueries();
            return updated;
        },
    ),
);

export const createResource = command(
    CreateResourceInput,
    withRemoteLogging(
        "resources.createResource",
        "command",
        async (input: v.InferOutput<typeof CreateResourceInput>) => {
            await requireWorkspaceAccess(input.workspaceId);
            return await createResourceRecord(input);
        },
    ),
);

export const createResourceFromTemplate = command(
    CreateResourceFromTemplateInput,
    withRemoteLogging(
        "resources.createResourceFromTemplate",
        "command",
        async (input: v.InferOutput<typeof CreateResourceFromTemplateInput>) => {
            await requireWorkspaceAccess(input.workspaceId);
            return await createResourceFromTemplateRecord(input);
        },
    ),
);

export const copyResource = command(
    TransferResourceInput,
    withRemoteLogging(
        "resources.copyResource",
        "command",
        async ({ resourceId, targetWorkspaceId }: v.InferOutput<typeof TransferResourceInput>) => {
            await requireResourceAccess(resourceId);
            await requireWorkspaceAccess(targetWorkspaceId);
            const copied = await copyResourceRecord(resourceId, targetWorkspaceId);
            await refreshResourceQueries();
            return copied;
        },
    ),
);

export const moveResource = command(
    TransferResourceInput,
    withRemoteLogging(
        "resources.moveResource",
        "command",
        async ({ resourceId, targetWorkspaceId }: v.InferOutput<typeof TransferResourceInput>) => {
            await requireResourceAccess(resourceId);
            await requireWorkspaceAccess(targetWorkspaceId);
            const moved = await moveResourceRecord(resourceId, targetWorkspaceId);
            await refreshResourceQueries();
            return moved;
        },
    ),
);

export const updateResourceCompose = command(
    UpdateResourceComposeInput,
    withRemoteLogging(
        "resources.updateResourceCompose",
        "command",
        async ({ compose, resourceId }: v.InferOutput<typeof UpdateResourceComposeInput>) => {
            await requireResourceAccess(resourceId);
            return await updateResourceComposeRecord(resourceId, compose);
        },
    ),
);

export const previewResourceCompose = command(
    UpdateResourceComposeInput,
    withRemoteLogging(
        "resources.previewResourceCompose",
        "command",
        async ({ compose, resourceId }: v.InferOutput<typeof UpdateResourceComposeInput>) => {
            await requireResourceAccess(resourceId);
            return await previewResourceComposeRecord(resourceId, compose);
        },
    ),
);

export const updateEnvironmentVariables = command(
    UpdateResourceEnvironmentInput,
    withRemoteLogging(
        "resources.updateEnvironmentVariables",
        "command",
        async ({ resourceId, variables }: v.InferOutput<typeof UpdateResourceEnvironmentInput>) => {
            await requireResourceAccess(resourceId);
            return await replaceEnvironmentVariables(resourceId, variables);
        },
    ),
);

export const updateResourceIdentity = command(
    UpdateResourceIdentityInput,
    withRemoteLogging(
        "resources.updateResourceIdentity",
        "command",
        async ({ icon, name, resourceId }: v.InferOutput<typeof UpdateResourceIdentityInput>) => {
            await requireResourceAccess(resourceId);
            const updated = await updateResourceIdentityRecord(resourceId, {
                icon,
                name,
            });
            await refreshResourceQueries();
            return updated;
        },
    ),
);

export const updateResourceSettings = command(
    UpdateResourceSettingsInput,
    withRemoteLogging(
        "resources.updateResourceSettings",
        "command",
        async ({ resourceId, settings }: v.InferOutput<typeof UpdateResourceSettingsInput>) => {
            await requireResourceAccess(resourceId);
            const updated = await updateResourceSettingsRecord(resourceId, settings);
            await refreshResourceQueries();
            return updated;
        },
    ),
);

export const deployResource = command(
    ResourceIdInput,
    withRemoteLogging(
        "resources.deployResource",
        "command",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await deployResourceRecord(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);

export const deleteResource = command(
    ResourceIdInput,
    withRemoteLogging(
        "resources.deleteResource",
        "command",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);
            return await deleteResourceRecord(resourceId);
        },
        { inputKey: "resourceId" },
    ),
);
