import fs from "node:fs/promises";
import path from "node:path";

import { query } from "$app/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { dataSource, services, workspace } from "#lib/server/db/schema";

import { createDataSourceFolder } from "../server/data-source";
import { db } from "../server/db";
import { uniqueSlug } from "../server/slugs";

export const listWorkspaces = query(async () =>
  // oxlint-disable-next-line unicorn/no-await-expression-member / its fine shut up
  (await db.select().from(workspace).orderBy(workspace.createdAt)).toReversed(),
);

export const getWorkspace = query(v.string(), async (id) => {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));

  return wrk;
});

const CreateWorkspaceInput = v.object({
  dataSourceId: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(3)),
});

export const createWorkspace = query(CreateWorkspaceInput, async ({ dataSourceId, name }) => {
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
    await createDataSourceFolder(source.path, created.slug);
  } catch (error) {
    await db.delete(workspace).where(eq(workspace.id, created.id));
    throw error;
  }

  return created;
});

export const deleteWorkspace = query(v.string(), async (id) => {
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

  await fs.rm(path.join(source.path, wrk.slug), {
    force: true,
    recursive: true,
  });

  return deleted;
});
