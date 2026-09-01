import { error, redirect } from "@sveltejs/kit";

import { hasAccessToThisService } from "#lib/server/access";
import { getGravatarUrl } from "#lib/shared/gravatar";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, params }) => {
    const { session } = locals;

    if (!session) {
        redirect(303, "/login");
    }

    if (!(await hasAccessToThisService(session.user.id, params.serviceId))) {
        error(403, "Forbidden");
    }

    return {
        gravatarUrl: session.user.image ? null : await getGravatarUrl(session.user.email),
        session,
    };
};
