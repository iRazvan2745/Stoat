import type { Context as ApiContext } from "@stoat/api/context";

import { getDb } from "./services";
import { auth } from "./services";

export type CreateContextOptions = {
  headers: Headers;
};

export async function createContext({ headers }: CreateContextOptions): Promise<ApiContext> {
  const db = await getDb();
  const session = await auth.api.getSession({ headers });
  return {
    db,
    auth: null,
    session,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
