// oxlint-disable func-style
import { query } from "$app/server";

import { listTemplates } from "#lib/server/templates";

export const getTemplates = query(async () => await listTemplates());
