import { error, redirect } from "@sveltejs/kit";

import { hasAccessToThisWorkspace } from "#lib/server/access";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, params }) => {
  const { session } = locals;

  if (!session) {
    redirect(303, "/login");
  }

  if (!(await hasAccessToThisWorkspace(session.user.id, params.workspaceId))) {
    error(403, "Forbidden");
  }

  return {};
};
