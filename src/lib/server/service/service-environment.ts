// oxlint-disable func-style
import { asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { environmentVariables, services } from "#lib/db/schema";
import type { EnvironmentVariable } from "#lib/environment";

export async function listEnvironmentVariables(serviceId: string) {
  return await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.serviceId, serviceId))
    .orderBy(asc(environmentVariables.name));
}

export async function replaceEnvironmentVariables(
  serviceId: string,
  variables: readonly EnvironmentVariable[],
) {
  const [svc] = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.id, serviceId));

  if (!svc) {
    throw new Error("Service not found");
  }

  return await db.transaction(async (tx) => {
    await tx.delete(environmentVariables).where(eq(environmentVariables.serviceId, serviceId));

    if (variables.length === 0) {
      return [];
    }

    return await tx
      .insert(environmentVariables)
      .values(
        variables.map((variable) => ({
          name: variable.name,
          serviceId,
          value: variable.value,
        })),
      )
      .returning();
  });
}

export async function deleteEnvironmentVariablesForService(serviceId: string): Promise<void> {
  await db.delete(environmentVariables).where(eq(environmentVariables.serviceId, serviceId));
}
