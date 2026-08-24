import { auth } from "#lib/auth";
import { getGravatarUrl } from "#lib/gravatar";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ request }) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  return {
    gravatarUrl:
      session?.user && !session.user.image ? await getGravatarUrl(session.user.email) : null,
    session,
  };
};
