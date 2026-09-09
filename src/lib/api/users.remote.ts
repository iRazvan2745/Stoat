import { command, query } from "$app/server";
import * as v from "valibot";

import { requireSession } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { UserSettingsSchema } from "#lib/domain/users/settings";
import {
    getUserSettings as getUserSettingsRecord,
    updateUserSettings as updateUserSettingsRecord,
} from "#lib/server/users/settings";

const UpdateUserSettingsInput = v.object({
    settings: UserSettingsSchema,
});

export const getUserSettings = query(
    withRemoteLogging("users.getUserSettings", "query", async () => {
        const session = requireSession();
        return await getUserSettingsRecord(session.user.id);
    }),
);

export const updateUserSettings = command(
    UpdateUserSettingsInput,
    withRemoteLogging(
        "users.updateUserSettings",
        "command",
        async ({ settings }: v.InferOutput<typeof UpdateUserSettingsInput>) => {
            const session = requireSession();
            return await updateUserSettingsRecord(session.user.id, settings);
        },
    ),
);
