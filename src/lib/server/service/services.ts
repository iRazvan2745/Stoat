// oxlint-disable func-style
import { eq } from "drizzle-orm";

import { db } from "#lib/server/db";
import { services } from "#lib/server/db/schema";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";

export async function getService(id: string) {
  const [op] = await db.select().from(services).where(eq(services.id, id));

  return op;
}

export async function getFormattedCompose(serviceId: string) {
  const svc = await getService(serviceId);

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  return formatComposeFile(svc.value, svc.slug ?? svc.id);
}
