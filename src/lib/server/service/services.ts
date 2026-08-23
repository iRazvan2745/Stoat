// oxlint-disable func-style
import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import type { EnvironmentVariable } from "#lib/environment";
import { createDataSourceFolder, resolveDataSourcePath } from "#lib/server/data-source/paths";
import { db } from "#lib/server/db";
import { dataSource, services, workspace } from "#lib/server/db/schema";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import {
  deleteEnvironmentVariablesForService,
  replaceEnvironmentVariables,
} from "#lib/server/service/service-environment";
import { uniqueSlug } from "#lib/server/shared/slugs";
import { readTemplateIconValue, readTemplateVersion } from "#lib/server/templates";
import {
  mergeServiceSettings,
  parseServiceSettings,
  shouldPrefixServices,
} from "#lib/service/settings";
import type { ServiceSettings } from "#lib/service/settings";
import { expandTemplateSecrets, expandTemplateVariables } from "#lib/templates";

export interface CreateServiceInput {
  icon?: string;
  name: string;
  type: string;
  value: string;
  variables: readonly EnvironmentVariable[];
  workspaceId: string;
}

export async function getService(id: string) {
  const [op] = await db.select().from(services).where(eq(services.id, id));

  return op;
}

export async function listServicesInWorkspace(workspaceId: string) {
  return await db.select().from(services).where(eq(services.workspaceId, workspaceId));
}

export async function createService({
  icon,
  name,
  type,
  value,
  variables,
  workspaceId,
}: CreateServiceInput) {
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
}

export async function createServiceFromTemplate({
  appId,
  name,
  version,
  workspaceId,
}: {
  appId: string;
  name: string;
  version: string;
  workspaceId: string;
}) {
  const template = await readTemplateVersion(appId, version);

  return await createService({
    icon: (await readTemplateIconValue(appId, template.manifest.icon)) ?? undefined,
    name,
    type: template.manifest.type,
    value: expandTemplateSecrets(template.compose),
    variables: expandTemplateVariables(template.variables),
    workspaceId,
  });
}

export async function updateServiceCompose(id: string, compose: string) {
  return await db.update(services).set({ value: compose }).where(eq(services.id, id)).returning();
}

export async function deleteService(id: string) {
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
}

export async function updateServiceSettings(serviceId: string, settings: ServiceSettings) {
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

  return updated;
}

export function serviceComposePrefix(svc: {
  id: string;
  settings?: unknown;
  slug: string | null;
}): string | undefined {
  if (!shouldPrefixServices(parseServiceSettings(svc.settings))) {
    return undefined;
  }

  return svc.slug ?? svc.id;
}

export async function getFormattedCompose(serviceId: string) {
  const svc = await getService(serviceId);

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  return formatComposeFile(svc.value, serviceComposePrefix(svc));
}

export async function previewServiceCompose(serviceId: string, compose: string) {
  const svc = await getService(serviceId);

  if (!svc) {
    throw new Error("Service not found");
  }

  return formatComposeFile(compose, serviceComposePrefix(svc));
}
