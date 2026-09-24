import type { Context as ApiContext } from "@stoat/api/context";

import { getAuth, getDb } from "./services";

export type CreateContextOptions = {
    headers: Headers;
};

export async function createContext({ headers }: CreateContextOptions): Promise<ApiContext> {
    const db = await getDb();
    const session = await getAuth().api.getSession({ headers });

    return {
        db,
        session,
    };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
