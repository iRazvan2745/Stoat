import { createAuth as createConfiguredAuth } from "@stoat/auth";
import { type Database, createDb } from "@stoat/db";

import { env } from "./env.server";

let db: Database | undefined;

let auth: ReturnType<typeof createConfiguredAuth> | undefined;

// Dynamic configuration is only available at runtime, not during build analysis.
export function getDb(): Database {
    return (db ??= createDb(env));
}

export function getAuth() {
    return (auth ??= createConfiguredAuth(env, getDb()));
}
