import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { createDataSourceFolder, resolveDataSourcePath } from "#lib/server/data-source/paths";
import { db } from "#lib/server/db";
import { dataSource, services, workspace } from "#lib/server/db/schema";
import { uniqueSlug } from "#lib/server/shared/slugs";

export const listWorkspaces = async () => {
  const workspaces = await db.select().from(workspace).orderBy(workspace.createdAt);

  return workspaces.toReversed();
};

export const getWorkspace = async (id: string) => {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));

  return wrk;
};

export const createWorkspace = async ({
  dataSourceId,
  name,
}: {
  dataSourceId: string;
  name: string;
}) => {
  const [source] = await db.select().from(dataSource).where(eq(dataSource.id, dataSourceId));

  if (!source) {
    throw new Error("Data source not found");
  }

  if (!source.path) {
    throw new Error("Data source does not have a path");
  }

  const slug = await uniqueSlug(name, async (candidate) => {
    const matches = await db
      .select({ slug: workspace.slug })
      .from(workspace)
      .where(eq(workspace.slug, candidate));

    return matches.length > 0;
  });

  const [created] = await db.insert(workspace).values({ dataSourceId, name, slug }).returning();

  if (!created) {
    throw new Error("Unable to create workspace");
  }

  try {
    await createDataSourceFolder(resolveDataSourcePath(source.path), created.slug);
  } catch (error) {
    await db.delete(workspace).where(eq(workspace.id, created.id));
    throw error;
  }

  return created;
};

export const deleteWorkspace = async (id: string) => {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));

  if (!wrk) {
    throw new Error("Workspace not found");
  }

  const [source] = await db.select().from(dataSource).where(eq(dataSource.id, wrk.dataSourceId));

  if (!source?.path) {
    throw new Error("Data source does not have a path");
  }

  const deleted = await db.transaction(async (tx) => {
    await tx.delete(services).where(eq(services.workspaceId, id));

    return await tx.delete(workspace).where(eq(workspace.id, id)).returning();
  });

  await fs.rm(path.join(resolveDataSourcePath(source.path), wrk.slug), {
    force: true,
    recursive: true,
  });

  return deleted;
};
