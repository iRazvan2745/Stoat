import * as v from "valibot";

export interface UserSettings {
    showFolderResourceNames?: boolean;
}

export const UserSettingsSchema = v.object({
    showFolderResourceNames: v.optional(v.boolean()),
});

export function parseUserSettings(value: unknown): UserSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as UserSettings;
}

// Resource names inside folders are shown unless the user turned them off;
// the field is only stored when it differs from that default.
export function showFolderResourceNames(settings?: UserSettings | null): boolean {
    return settings?.showFolderResourceNames !== false;
}

export function mergeUserSettings(current: unknown, patch: UserSettings): UserSettings {
    const next = parseUserSettings(current);

    if ("showFolderResourceNames" in patch) {
        if (patch.showFolderResourceNames === false) {
            next.showFolderResourceNames = false;
        } else {
            delete next.showFolderResourceNames;
        }
    }

    return next;
}
