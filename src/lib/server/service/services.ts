// oxlint-disable func-style
import { eq } from "drizzle-orm";

import { db } from "#lib/server/db";
import { services } from "#lib/server/db/schema";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import { parseServiceSettings, shouldPrefixServices } from "#lib/service-settings";

export async function getService(id: string) {
  const [op] = await db.select().from(services).where(eq(services.id, id));

  return op;
}

export function serviceComposePrefix(svc: {
  id: string;
  settings?: unknown;
  slug: string | null;
}): string | undefined {
  if (!shouldPrefixServices(parseServiceSettings(svc.settings))) {
    return undefined;
  }

  return svc.slug ?? svc.id;
}

export async function getFormattedCompose(serviceId: string) {
  const svc = await getService(serviceId);

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  return formatComposeFile(svc.value, serviceComposePrefix(svc));
}

export async function previewServiceCompose(serviceId: string, compose: string) {
  const svc = await getService(serviceId);

  if (!svc) {
    throw new Error("Service not found");
  }

  return formatComposeFile(compose, serviceComposePrefix(svc));
}
