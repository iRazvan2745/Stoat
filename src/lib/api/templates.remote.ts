// oxlint-disable func-style
import { query } from "$app/server";

import { requireSession } from "#lib/api/guard";
import { listTemplates } from "#lib/server/templates";

export const getTemplates = query(async () => {
  requireSession();
  return await listTemplates();
});
