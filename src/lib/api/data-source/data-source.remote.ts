import fs from "node:fs/promises";
import path from "node:path";

import { query } from "$app/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { createDataSourceFolder, getDataDir } from "#lib/server/data-source";
import { db } from "#lib/server/db";
import { dataSource } from "#lib/server/db/schema";

const DataSource = v.object({
  url: v.string(),
});

export const listDataSources = query(async () => {
  const ds = await db.select().from(dataSource);

  return ds;
});

export const createDataSource = query(DataSource, async ({ url }) => {
  const id = crypto.randomUUID();
  const dataSourcePath = path.join(getDataDir(), id);

  const [created] = await db
    .insert(dataSource)
    .values({ id, path: dataSourcePath, url })
    .returning();

  if (!created) {
    throw new Error("Unable to create data source");
  }

  try {
    await createDataSourceFolder(dataSourcePath);
  } catch (error) {
    await db.delete(dataSource).where(eq(dataSource.id, created.id));
    throw error;
  }

  return created;
});

export const deleteDataSource = query(v.string(), async (id) => {
  const [deleted] = await db.delete(dataSource).where(eq(dataSource.id, id)).returning();

  if (!deleted) {
    throw new Error("Data source not found");
  }

  await fs.rm(deleted.path, { force: true, recursive: true });

  return [deleted];
});
