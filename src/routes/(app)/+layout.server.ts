import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { db } from "#lib/db";
import { member, organization } from "#lib/db/schema";
import { getGravatarUrl } from "#lib/shared/gravatar";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
    const { session } = locals;

    if (!session) {
        redirect(303, "/login");
    }

    const organizations = await db
        .select({
            id: organization.id,
            logo: organization.logo,
            name: organization.name,
            slug: organization.slug,
        })
        .from(organization)
        .innerJoin(member, eq(member.organizationId, organization.id))
        .where(eq(member.userId, session.user.id))
        .orderBy(organization.name);

    return {
        gravatarUrl:
            (session.user.image?.length ?? 0) > 0 ? null : await getGravatarUrl(session.user.email),
        organizations,
        session,
    };
};
