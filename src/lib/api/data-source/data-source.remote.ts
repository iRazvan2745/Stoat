import { query } from "$app/server";
import * as v from "valibot";

import { db } from "#lib/server/db";
import { dataSource } from "#lib/server/db/schema";

const DataSource = v.object({
  path: v.string(),
  url: v.string(),
});

export const listDataSources = query(async () => {
  const ds = await db.select().from(dataSource);

  return ds;
});

export const createDataSource = query(DataSource, async ({ path, url }) => {
  const op = await db.insert(dataSource).values({ path, url });

  return op;
});
