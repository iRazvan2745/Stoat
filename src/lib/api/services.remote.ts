import { command, getRequestEvent, query, requested } from "$app/server";
import * as v from "valibot";

import { requireServiceAccess, requireWorkspaceAccess } from "#lib/api/guard";
import { withRemoteLiveLogging, withRemoteLogging } from "#lib/api/remote-logging";
import { ENV_NAME_PATTERN } from "#lib/domain/environment";
import { MAX_SERVICE_NAME_LENGTH } from "#lib/domain/services/identity";
import { ServiceSettingsSchema } from "#lib/domain/services/settings";
import { deployService as deployServiceRecord } from "#lib/server/deployments/deployments";
import { getPostgresConnection as getPostgresConnectionRecord } from "#lib/server/services/service-connection";
import { listServiceContainers as listServiceContainerRecords } from "#lib/server/services/service-containers";
import {
    listEnvironmentVariables as listServiceEnvironmentVariables,
    replaceEnvironmentVariables,
} from "#lib/server/services/service-environment";
import { listServiceIngresses as listServiceIngressRecords } from "#lib/server/services/service-ingresses";
import { streamServiceContainerLogs as streamServiceContainerLogsFromServer } from "#lib/server/services/service-logs";
import {
    createService as createServiceRecord,
    createServiceFromTemplate as createServiceFromTemplateRecord,
    deleteService as deleteServiceRecord,
    getService as getServiceRecord,
    listServicesInWorkspace as listServicesInWorkspaceRecords,
    previewServiceCompose as previewServiceComposeRecord,
    updateServiceCompose as updateServiceComposeRecord,
    updateServiceIdentity as updateServiceIdentityRecord,
    updateServiceSettings as updateServiceSettingsRecord,
} from "#lib/server/services/services";
import { isAbortError } from "#lib/server/shared/sse";

const ServiceIdInput = v.string();
const WorkspaceIdInput = v.string();

const EnvironmentVariableInput = v.object({
    name: v.pipe(v.string(), v.regex(ENV_NAME_PATTERN)),
    value: v.string(),
});

const CreateServiceInput = v.object({
    icon: v.optional(v.string()),
    name: v.pipe(v.string(), v.minLength(1)),
    type: v.optional(v.string(), "compose"),
    value: v.optional(v.string(), ""),
    variables: v.optional(v.array(EnvironmentVariableInput), []),
    workspaceId: WorkspaceIdInput,
});

const CreateServiceFromTemplateInput = v.object({
    appId: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(1)),
    version: v.pipe(v.string(), v.minLength(1)),
    workspaceId: WorkspaceIdInput,
});

const UpdateServiceComposeInput = v.object({
    compose: v.string(),
    serviceId: ServiceIdInput,
});

const UpdateServiceEnvironmentInput = v.pipe(
    v.object({
        serviceId: ServiceIdInput,
        variables: v.array(EnvironmentVariableInput),
    }),
    v.check(
        (input) =>
            new Set(input.variables.map((variable) => variable.name)).size ===
            input.variables.length,
        "Environment variable names must be unique",
    ),
);

const UpdateServiceIdentityInput = v.pipe(
    v.object({
        icon: v.optional(v.nullable(v.string())),
        name: v.optional(
            v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_SERVICE_NAME_LENGTH)),
        ),
        serviceId: ServiceIdInput,
    }),
    v.check(
        (input) => input.icon !== undefined || input.name !== undefined,
        "Name or icon is required",
    ),
);

const UpdateServiceSettingsInput = v.object({
    serviceId: ServiceIdInput,
    settings: ServiceSettingsSchema,
});

// Queries
export const listServicesInWorkspace = query(
    WorkspaceIdInput,
    withRemoteLogging(
        "services.listServicesInWorkspace",
        "query",
        async (workspaceId: string) => {
            await requireWorkspaceAccess(workspaceId);
            return await listServicesInWorkspaceRecords(workspaceId);
        },
        { inputKey: "workspaceId" },
    ),
);

export const getService = query(
    ServiceIdInput,
    withRemoteLogging(
        "services.getService",
        "query",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await getServiceRecord(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);

export const getPostgresConnection = query(
    ServiceIdInput,
    withRemoteLogging(
        "services.getPostgresConnection",
        "query",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await getPostgresConnectionRecord(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);

export const listEnvironmentVariables = query(
    ServiceIdInput,
    withRemoteLogging(
        "services.listEnvironmentVariables",
        "query",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await listServiceEnvironmentVariables(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);

export const listServiceContainers = query(
    ServiceIdInput,
    withRemoteLogging(
        "services.listServiceContainers",
        "query",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await listServiceContainerRecords(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);

export const listServiceIngresses = query(
    ServiceIdInput,
    withRemoteLogging(
        "services.listServiceIngresses",
        "query",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await listServiceIngressRecords(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);

// Live queries
const streamServiceContainerLogsRemote = async function* streamServiceContainerLogsRemote(
    serviceId: string,
) {
    await requireServiceAccess(serviceId);

    const { request } = getRequestEvent();

    try {
        yield* streamServiceContainerLogsFromServer(serviceId, request.signal);
    } catch (error) {
        if (isAbortError(error)) {
            return;
        }

        throw error;
    }
};

export const streamServiceContainerLogs = query.live(
    ServiceIdInput,
    withRemoteLiveLogging("services.streamServiceContainerLogs", streamServiceContainerLogsRemote, {
        inputKey: "serviceId",
    }),
);

const SERVICE_QUERY_REFRESH_LIMIT = 8;

const refreshServiceQueries = async (): Promise<void> => {
    await requested(getService, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listServiceContainers, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(getPostgresConnection, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listEnvironmentVariables, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listServicesInWorkspace, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(listServiceIngresses, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
    await requested(streamServiceContainerLogs, SERVICE_QUERY_REFRESH_LIMIT).reconnectAll();
};

// Commands
export const createService = command(
    CreateServiceInput,
    withRemoteLogging(
        "services.createService",
        "command",
        async (input: v.InferOutput<typeof CreateServiceInput>) => {
            await requireWorkspaceAccess(input.workspaceId);
            return await createServiceRecord(input);
        },
    ),
);

export const createServiceFromTemplate = command(
    CreateServiceFromTemplateInput,
    withRemoteLogging(
        "services.createServiceFromTemplate",
        "command",
        async (input: v.InferOutput<typeof CreateServiceFromTemplateInput>) => {
            await requireWorkspaceAccess(input.workspaceId);
            return await createServiceFromTemplateRecord(input);
        },
    ),
);

export const updateServiceCompose = command(
    UpdateServiceComposeInput,
    withRemoteLogging(
        "services.updateServiceCompose",
        "command",
        async ({ compose, serviceId }: v.InferOutput<typeof UpdateServiceComposeInput>) => {
            await requireServiceAccess(serviceId);
            return await updateServiceComposeRecord(serviceId, compose);
        },
    ),
);

export const previewServiceCompose = command(
    UpdateServiceComposeInput,
    withRemoteLogging(
        "services.previewServiceCompose",
        "command",
        async ({ compose, serviceId }: v.InferOutput<typeof UpdateServiceComposeInput>) => {
            await requireServiceAccess(serviceId);
            return await previewServiceComposeRecord(serviceId, compose);
        },
    ),
);

export const updateEnvironmentVariables = command(
    UpdateServiceEnvironmentInput,
    withRemoteLogging(
        "services.updateEnvironmentVariables",
        "command",
        async ({ serviceId, variables }: v.InferOutput<typeof UpdateServiceEnvironmentInput>) => {
            await requireServiceAccess(serviceId);
            return await replaceEnvironmentVariables(serviceId, variables);
        },
    ),
);

export const updateServiceIdentity = command(
    UpdateServiceIdentityInput,
    withRemoteLogging(
        "services.updateServiceIdentity",
        "command",
        async ({ icon, name, serviceId }: v.InferOutput<typeof UpdateServiceIdentityInput>) => {
            await requireServiceAccess(serviceId);
            const updated = await updateServiceIdentityRecord(serviceId, {
                icon,
                name,
            });
            await refreshServiceQueries();
            return updated;
        },
    ),
);

export const updateServiceSettings = command(
    UpdateServiceSettingsInput,
    withRemoteLogging(
        "services.updateServiceSettings",
        "command",
        async ({ serviceId, settings }: v.InferOutput<typeof UpdateServiceSettingsInput>) => {
            await requireServiceAccess(serviceId);
            const updated = await updateServiceSettingsRecord(serviceId, settings);
            await refreshServiceQueries();
            return updated;
        },
    ),
);

export const deployService = command(
    ServiceIdInput,
    withRemoteLogging(
        "services.deployService",
        "command",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await deployServiceRecord(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);

export const deleteService = command(
    ServiceIdInput,
    withRemoteLogging(
        "services.deleteService",
        "command",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);
            return await deleteServiceRecord(serviceId);
        },
        { inputKey: "serviceId" },
    ),
);
