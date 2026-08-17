// oxlint-disable func-style
import fs from "node:fs/promises";
import path from "node:path";

import { query } from "$app/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import YAML, { isMap, isScalar } from "yaml";

import { createDataSourceFolder, getDataDir } from "#lib/server/data-source";
import { dataSource, services, workspace } from "#lib/server/db/schema";
import { uniqueSlug } from "#lib/server/slugs";

import { db } from "../server/db";

export const getServicesInWorkspace = query(
  v.string(),
  async (wrk) => await db.select().from(services).where(eq(services.workspaceId, wrk)),
);

const CreateServiceInput = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  value: v.optional(v.string(), ""),
  workspaceId: v.string(),
});

export const createService = query(CreateServiceInput, async ({ workspaceId, name, value }) => {
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
    .values({ name, slug, value, workspaceId })
    .returning();

  if (!created) {
    throw new Error("Unable to create service");
  }

  try {
    await createDataSourceFolder(
      workspaceRecord.dataSourcePath,
      workspaceRecord.slug,
      created.slug ?? slug,
    );
  } catch (error) {
    await db.delete(services).where(eq(services.id, created.id));
    throw error;
  }

  return created;
});

const UpdateComposeInput = v.object({
  compose: v.string(),
  id: v.string(),
});

export const updateCompose = query(UpdateComposeInput, async ({ compose, id }) => {
  const op = await db
    .update(services)
    .set({ value: compose })
    .where(eq(services.id, id))
    .returning();
  return op;
});

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

  const op = await db.delete(services).where(eq(services.id, id)).returning();

  await fs.rm(path.join(ds.path, wrk.slug, svc.slug ?? svc.id), {
    force: true,
    recursive: true,
  });

  return op;
});

export const getService = query(v.string(), async (id) => {
  const [op] = await db.select().from(services).where(eq(services.id, id));

  return op;
});

async function getDatasourceFromWorkspace(id: string) {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));
  if (!wrk) {
    throw new Error("workspace not found");
  }
  const [ds] = await db.select().from(dataSource).where(eq(dataSource.id, wrk.dataSourceId));

  if (!ds) {
    throw new Error("data source not found");
  }

  return ds;
}

async function getWorkspace(id: string) {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));
  if (!wrk) {
    throw new Error("workspace not found");
  }
  return wrk;
}

export const deployService = query(v.string(), async (id) => {
  const [svc] = await db.select().from(services).where(eq(services.id, id));

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  const doc = YAML.parseDocument(svc.value);

  if (doc.errors.length > 0) {
    throw new Error(`Invalid compose YAML`);
  }

  const serviceMap = doc.get("services", true);

  if (!isMap(serviceMap)) {
    throw new Error('Compose must contain a "services" map');
  }

  for (const pair of serviceMap.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error("Invalid service name");
    }

    pair.key.value = `${svc.slug}-${pair.key.value}`;
  }

  const compose = doc.toString();

  const wrk = await getWorkspace(svc.workspaceId);
  const ds = await getDatasourceFromWorkspace(svc.workspaceId);

  const serviceDir = path.join(getDataDir(), ds.id, wrk.slug, svc.slug ?? svc.id);

  await fs.mkdir(serviceDir, { recursive: true });

  await fs.writeFile(path.join(serviceDir, "compose.yaml"), compose, "utf-8");
});
