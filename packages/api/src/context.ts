import type { createAuth } from "@stoat/auth";
import type { Database } from "@stoat/db";

export type Context = {
  auth: null;
  session: Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>;
  db: Database;
};
