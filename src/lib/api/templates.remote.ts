import { query } from "$app/server";

import { requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { listTemplates as listTemplateRecords } from "#lib/server/templates";

export const listTemplates = query(
    withRemoteLogging("templates.listTemplates", "query", async () => {
        requireSession();
        return await listTemplateRecords();
    }),
);
