import { redirect } from "@sveltejs/kit";

import { getGravatarUrl } from "#lib/gravatar";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  const { session } = locals;

  if (!session) {
    redirect(303, "/login");
  }

  return {
    gravatarUrl: session.user.image ? null : await getGravatarUrl(session.user.email),
    session,
  };
};
