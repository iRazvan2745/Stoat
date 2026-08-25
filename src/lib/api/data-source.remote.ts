import { command, query } from "$app/server";
import * as v from "valibot";

import { requireSession } from "#lib/api/guard";
import {
  createDataSource as insertDataSource,
  deleteDataSource as removeDataSource,
  discoverDataSource as importDataSource,
  listDataSources as loadDataSources,
} from "#lib/server/data-source/data-sources";

const DataSource = v.object({
  uncloudUrl: v.string(),
  url: v.string(),
});

export const listDataSources = query(async () => {
  requireSession();
  return await loadDataSources();
});

export const createDataSource = command(DataSource, async ({ uncloudUrl, url }) => {
  requireSession();
  return await insertDataSource(url, uncloudUrl);
});

export const discoverDataSource = command(v.string(), async (id) => {
  requireSession();
  return await importDataSource(id);
});

export const deleteDataSource = command(v.string(), async (id) => {
  requireSession();
  return await removeDataSource(id);
});
