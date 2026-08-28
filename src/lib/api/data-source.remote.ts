import { command, query } from "$app/server";
import { error } from "@sveltejs/kit";
import * as v from "valibot";

import { requireDataSourceAccess, requireSession } from "#lib/api/guard";
import { getOrganizationIdForUser } from "#lib/server/access";
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
  const session = requireSession();
  return await loadDataSources(session.user.id);
});

export const createDataSource = command(DataSource, async ({ uncloudUrl, url }) => {
  const session = requireSession();
  const organizationId = await getOrganizationIdForUser(
    session.user.id,
    session.session.activeOrganizationId,
  );

  if (!organizationId) {
    error(403, "No organization membership");
  }

  return await insertDataSource(url, uncloudUrl, organizationId);
});

export const discoverDataSource = command(v.string(), async (id) => {
  await requireDataSourceAccess(id);
  return await importDataSource(id);
});

export const deleteDataSource = command(v.string(), async (id) => {
  await requireDataSourceAccess(id);
  return await removeDataSource(id);
});
