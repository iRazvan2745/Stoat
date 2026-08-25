// oxlint-disable func-style
import { command, getRequestEvent, query, requested } from "$app/server";
import * as v from "valibot";

import { requireSession } from "#lib/api/guard";
import { ENV_NAME_PATTERN } from "#lib/environment";
import { deployService as runDeployment } from "#lib/server/deployments/deployments";
import { getPostgresConnection as loadPostgresConnection } from "#lib/server/service/service-connection";
import { listServiceIngresses } from "#lib/server/service/service-ingresses";
import { listServiceContainers } from "#lib/server/service/service-containers";
import {
  listEnvironmentVariables,
  replaceEnvironmentVariables,
} from "#lib/server/service/service-environment";
import { streamServiceContainerLogs } from "#lib/server/service/service-logs";
import {
  createService as insertService,
  createServiceFromTemplate as insertServiceFromTemplate,
  deleteService as removeService,
  getService as loadService,
  listServicesInWorkspace,
  previewServiceCompose as loadPreviewCompose,
  updateServiceCompose,
  updateServiceSettings as saveServiceSettings,
} from "#lib/server/service/services";
import { isAbortError } from "#lib/server/shared/sse";
import { ServiceSettingsSchema } from "#lib/service/settings";

export const getServicesInWorkspace = query(v.string(), async (workspaceId) => {
  requireSession();
  return await listServicesInWorkspace(workspaceId);
});

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
  workspaceId: v.string(),
});

export const createService = command(CreateServiceInput, async (input) => {
  requireSession();
  return await insertService(input);
});

const CreateServiceFromTemplateInput = v.object({
  appId: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  version: v.pipe(v.string(), v.minLength(1)),
  workspaceId: v.string(),
});

export const createServiceFromTemplate = command(CreateServiceFromTemplateInput, async (input) => {
  requireSession();
  return await insertServiceFromTemplate(input);
});

const UpdateComposeInput = v.object({
  compose: v.string(),
  id: v.string(),
});

export const updateCompose = command(UpdateComposeInput, async ({ compose, id }) => {
  requireSession();
  return await updateServiceCompose(id, compose);
});

export const previewCompose = command(UpdateComposeInput, async ({ compose, id }) => {
  requireSession();
  return await loadPreviewCompose(id, compose);
});

export const deleteService = command(v.string(), async (id) => {
  requireSession();
  return await removeService(id);
});

export const getService = query(v.string(), async (id) => {
  requireSession();
  return await loadService(id);
});

export const getPostgresConnection = query(v.string(), async (serviceId) => {
  requireSession();
  return await loadPostgresConnection(serviceId);
});

export const getEnvironmentVariables = query(v.string(), async (serviceId) => {
  requireSession();
  return await listEnvironmentVariables(serviceId);
});

const UpdateEnvironmentInput = v.pipe(
  v.object({
    serviceId: v.string(),
    variables: v.array(EnvironmentVariableInput),
  }),
  v.check(
    (input) =>
      new Set(input.variables.map((variable) => variable.name)).size === input.variables.length,
    "Environment variable names must be unique",
  ),
);

export const updateEnvironmentVariables = command(
  UpdateEnvironmentInput,
  async ({ serviceId, variables }) => {
    requireSession();
    return await replaceEnvironmentVariables(serviceId, variables);
  },
);

export const deployService = command(v.string(), async (id) => {
  requireSession();
  return await runDeployment(id);
});

export const getServiceContainers = query(v.string(), async (id) => {
  requireSession();
  return await listServiceContainers(id);
});

export const getServiceIngresses = query(v.string(), async (id) => {
  requireSession();
  return await listServiceIngresses(id);
});

const streamServiceContainerLogsRemote = async function* streamServiceContainerLogsRemote(
  serviceId: string,
) {
  requireSession();

  const { request } = getRequestEvent();

  try {
    yield* streamServiceContainerLogs(serviceId, request.signal);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }

    throw error;
  }
};

export const getServiceContainerLogs = query.live(v.string(), streamServiceContainerLogsRemote);

const SERVICE_QUERY_REFRESH_LIMIT = 8;

async function refreshServiceQueries(): Promise<void> {
  await requested(getService, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
  await requested(getServiceContainers, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
  await requested(getPostgresConnection, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
  await requested(getEnvironmentVariables, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
  await requested(getServicesInWorkspace, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
  await requested(getServiceIngresses, SERVICE_QUERY_REFRESH_LIMIT).refreshAll();
  await requested(getServiceContainerLogs, SERVICE_QUERY_REFRESH_LIMIT).reconnectAll();
}

const UpdateServiceSettingsInput = v.object({
  serviceId: v.string(),
  settings: ServiceSettingsSchema,
});

export const updateServiceSettings = command(
  UpdateServiceSettingsInput,
  async ({ serviceId, settings }) => {
    requireSession();
    const updated = await saveServiceSettings(serviceId, settings);
    await refreshServiceQueries();
    return updated;
  },
);
