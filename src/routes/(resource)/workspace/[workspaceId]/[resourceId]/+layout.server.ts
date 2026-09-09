import { error, redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { db } from "#lib/db";
import { resources } from "#lib/db/schema";
import { hasAccessToThisResource } from "#lib/server/access";
import { getGravatarUrl } from "#lib/shared/gravatar";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, params }) => {
    const { session } = locals;

    if (!session) {
        redirect(303, "/login");
    }

    if (!(await hasAccessToThisResource(session.user.id, params.resourceId))) {
        error(403, "Forbidden");
    }

    const [resource] = await db
        .select({ workspaceId: resources.workspaceId })
        .from(resources)
        .where(eq(resources.id, params.resourceId));

    if (!resource) {
        error(404, "Resource not found");
    }

    if (resource.workspaceId !== params.workspaceId) {
        error(404, "Resource not found");
    }

    return {
        gravatarUrl: session.user.image ? null : await getGravatarUrl(session.user.email),
        session,
    };
};
