import { command, query } from "$app/server";
import * as v from "valibot";

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

export const listDataSources = query(async () => await loadDataSources());

export const createDataSource = query(
  DataSource,
  async ({ uncloudUrl, url }) => await insertDataSource(url, uncloudUrl),
);

export const discoverDataSource = command(v.string(), async (id) => await importDataSource(id));

export const deleteDataSource = query(v.string(), async (id) => await removeDataSource(id));
