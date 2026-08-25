import { redirect } from "@sveltejs/kit";

import { isSignupAllowed } from "#lib/auth";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => {
  if (locals.session) {
    redirect(303, "/workspace");
  }

  return { allowSignup: isSignupAllowed() };
};
