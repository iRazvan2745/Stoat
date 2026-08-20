// oxlint-disable func-style
import fs from "node:fs/promises";
import path from "node:path";

import { command, getRequestEvent, query, requested } from "$app/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { ENV_NAME_PATTERN } from "#lib/environment";
import { createDataSourceFolder, resolveDataSourcePath } from "#lib/server/data-source";
import { dataSource, services, workspace } from "#lib/server/db/schema";
import { getPostgresConnection as loadPostgresConnection } from "#lib/server/service/service-connection";
import { previewServiceCompose as loadPreviewCompose } from "#lib/server/service/services";
import { uniqueSlug } from "#lib/server/slugs";
import { isAbortError } from "#lib/server/sse";
import { readTemplateIconValue, readTemplateVersion } from "#lib/server/templates";
import { ServiceSettingsSchema, mergeServiceSettings } from "#lib/service-settings";
import { expandTemplateSecrets, expandTemplateVariables } from "#lib/templates";

import { db } from "../server/db";
import { deployService as runDeployment } from "../server/deployments/deployments";
import { listServiceContainers } from "../server/service/service-containers";
import {
  deleteEnvironmentVariablesForService,
  listEnvironmentVariables,
  replaceEnvironmentVariables,
} from "../server/service/service-environment";
import { streamServiceContainerLogs } from "../server/service/service-logs";

export const getServicesInWorkspace = query(
  v.string(),
  async (wrk) => await db.select().from(services).where(eq(services.workspaceId, wrk)),
);

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

const insertService = async ({
  icon,
  name,
  type,
  value,
  variables,
  workspaceId,
}: v.InferOutput<typeof CreateServiceInput>) => {
  const [workspaceRecord] = await db
    .select({
      dataSourcePath: dataSource.path,
      slug: workspace.slug,
      workspaceId: workspace.id,
    })
    .from(workspace)
    .innerJoin(dataSource, eq(workspace.dataSourceId, dataSource.id))
    .where(eq(workspace.id, workspaceId));

  if (!workspaceRecord) {
    throw new Error("Workspace or data source not found");
  }

  if (!workspaceRecord.dataSourcePath) {
    throw new Error("Data source does not have a path");
  }

  const slug = await uniqueSlug(name, async (candidate) => {
    const matches = await db
      .select({ slug: services.slug })
      .from(services)
      .where(eq(services.slug, candidate));

    return matches.length > 0;
  });

  const [created] = await db
    .insert(services)
    .values({
      icon: icon?.trim() ? icon.trim() : null,
      name,
      slug,
      type,
      value,
      workspaceId,
    })
    .returning();

  if (!created) {
    throw new Error("Unable to create service");
  }

  try {
    await createDataSourceFolder(
      resolveDataSourcePath(workspaceRecord.dataSourcePath),
      workspaceRecord.slug,
      created.slug ?? slug,
    );

    if (variables.length > 0) {
      await replaceEnvironmentVariables(created.id, variables);
    }
  } catch (error) {
    await deleteEnvironmentVariablesForService(created.id);
    await db.delete(services).where(eq(services.id, created.id));
    throw error;
  }

  return created;
};

export const createService = query(CreateServiceInput, insertService);

const CreateServiceFromTemplateInput = v.object({
  appId: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  version: v.pipe(v.string(), v.minLength(1)),
  workspaceId: v.string(),
});

export const createServiceFromTemplate = query(
  CreateServiceFromTemplateInput,
  async ({ appId, name, version, workspaceId }) => {
    const template = await readTemplateVersion(appId, version);

    return await insertService({
      icon: (await readTemplateIconValue(appId, template.manifest.icon)) ?? undefined,
      name,
      type: template.manifest.type,
      value: expandTemplateSecrets(template.compose),
      variables: expandTemplateVariables(template.variables),
      workspaceId,
    });
  },
);

const UpdateComposeInput = v.object({
  compose: v.string(),
  id: v.string(),
});

export const updateCompose = command(UpdateComposeInput, async ({ compose, id }) => {
  const op = await db
    .update(services)
    .set({ value: compose })
    .where(eq(services.id, id))
    .returning();
  return op;
});

export const previewCompose = command(
  UpdateComposeInput,
  async ({ compose, id }) => await loadPreviewCompose(id, compose),
);

export const deleteService = query(v.string(), async (id) => {
  const [svc] = await db.select().from(services).where(eq(services.id, id));

  if (!svc) {
    throw new Error("Service not found");
  }

  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, svc.workspaceId));

  if (!wrk) {
    throw new Error("Workspace not found");
  }

  const [ds] = await db.select().from(dataSource).where(eq(dataSource.id, wrk.dataSourceId));

  if (!ds?.path) {
    throw new Error("Data source does not have a path");
  }

  await deleteEnvironmentVariablesForService(id);

  const op = await db.delete(services).where(eq(services.id, id)).returning();

  await fs.rm(path.join(resolveDataSourcePath(ds.path), wrk.slug, svc.slug ?? svc.id), {
    force: true,
    recursive: true,
  });

  return op;
});

export const getService = query(v.string(), async (id) => {
  const [op] = await db.select().from(services).where(eq(services.id, id));

  return op;
});

export const getPostgresConnection = query(
  v.string(),
  async (serviceId) => await loadPostgresConnection(serviceId),
);

export const getEnvironmentVariables = query(
  v.string(),
  async (serviceId) => await listEnvironmentVariables(serviceId),
);

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
  async ({ serviceId, variables }) => await replaceEnvironmentVariables(serviceId, variables),
);

export const deployService = command(v.string(), async (id) => await runDeployment(id));

export const getServiceContainers = query(
  v.string(),
  async (id) => await listServiceContainers(id),
);

const streamServiceContainerLogsRemote = async function* streamServiceContainerLogsRemote(
  serviceId: string,
) {
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
  await requested(getServiceContainerLogs, SERVICE_QUERY_REFRESH_LIMIT).reconnectAll();
}

const UpdateServiceSettingsInput = v.object({
  serviceId: v.string(),
  settings: ServiceSettingsSchema,
});

export const updateServiceSettings = command(
  UpdateServiceSettingsInput,
  async ({ serviceId, settings }) => {
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));

    if (!svc) {
      throw new Error("Service not found");
    }

    const [updated] = await db
      .update(services)
      .set({
        settings: mergeServiceSettings(svc.settings, settings),
      })
      .where(eq(services.id, serviceId))
      .returning();

    if (!updated) {
      throw new Error("Unable to update service settings");
    }

    await refreshServiceQueries();

    return updated;
  },
);
