import { getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";

type Session = NonNullable<App.Locals["session"]>;

// Session is resolved once per request in hooks.server.ts; remote functions
// only need to assert it exists.
export const requireSession = (): Session => {
  const { locals } = getRequestEvent();

  if (!locals.session) {
    error(401, "Unauthorized");
  }

  return locals.session;
};
