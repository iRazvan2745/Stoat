// oxlint-disable func-style
import fs from "node:fs/promises";
import path from "node:path";

import { command, query } from "$app/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { createDataSourceFolder, resolveDataSourcePath } from "#lib/server/data-source";
import { dataSource, services, workspace } from "#lib/server/db/schema";
import { uniqueSlug } from "#lib/server/slugs";

import { db } from "../server/db";
import { deployService as runDeployment } from "./deployments";

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
      resolveDataSourcePath(workspaceRecord.dataSourcePath),
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

export const updateCompose = command(UpdateComposeInput, async ({ compose, id }) => {
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

export const deployService = command(v.string(), async (id) => await runDeployment(id));
