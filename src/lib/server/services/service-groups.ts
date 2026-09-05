import { and, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { services } from "#lib/db/schema";

export const updateServiceGroup = async (
    workspaceId: string,
    serviceId: string,
    groupName: string | null,
): Promise<void> => {
    const updated = await db
        .update(services)
        .set({ groupName })
        .where(and(eq(services.id, serviceId), eq(services.workspaceId, workspaceId)))
        .returning({ serviceId: services.id });
    if (updated.length === 0) {
        throw new Error("Service is no longer in this workspace");
    }
};

export const updateServiceGroupName = async (
    workspaceId: string,
    groupName: string,
    newGroupName: string | null,
): Promise<void> => {
    await db
        .update(services)
        .set({ groupName: newGroupName })
        .where(and(eq(services.workspaceId, workspaceId), eq(services.groupName, groupName)));
};
