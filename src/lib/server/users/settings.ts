import { eq } from "drizzle-orm";

import { db } from "#lib/db";
import { userSettings } from "#lib/db/schema";
import { mergeUserSettings, type UserSettings } from "#lib/domain/users/settings";

export async function getUserSettings(userId: string): Promise<UserSettings> {
    const [row] = await db
        .select({ settings: userSettings.settings })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

    return row?.settings ?? {};
}

export async function updateUserSettings(
    userId: string,
    patch: UserSettings,
): Promise<UserSettings> {
    const current = await getUserSettings(userId);
    const next = mergeUserSettings(current, patch);

    const [updated] = await db
        .insert(userSettings)
        .values({ settings: next, userId })
        .onConflictDoUpdate({
            set: { settings: next },
            target: userSettings.userId,
        })
        .returning({ settings: userSettings.settings });

    return updated?.settings ?? next;
}
