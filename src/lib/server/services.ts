// oxlint-disable func-style
import { eq } from "drizzle-orm";

import { db } from "./db";
import { services } from "./db/schema";

export async function getService(id: string) {
  const [op] = await db.select().from(services).where(eq(services.id, id));

  return op;
}
