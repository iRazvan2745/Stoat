import { query } from "$app/server";
import { error } from "@sveltejs/kit";

import { requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { getOrganizationIdForUser } from "#lib/server/access";
import { getOrganizationOverview } from "#lib/server/overview/overview";

export const getOverview = query(
    withRemoteLogging("overview.getOverview", "query", async () => {
        const session = requireSession();
        const organizationId = await getOrganizationIdForUser(
            session.user.id,
            session.session.activeOrganizationId,
        );

        if (!organizationId) {
            error(403, "No organization membership");
        }

        return await getOrganizationOverview(organizationId);
    }),
);
