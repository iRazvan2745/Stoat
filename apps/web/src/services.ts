import { createAuth as createConfiguredAuth } from "@stoat/auth";
import { type Database, createDb } from "@stoat/db";

import { env } from "./env.server";

const db = createDb(env);

export function getDb(): Database {
  return db;
}
export const auth = createConfiguredAuth(env, db);
