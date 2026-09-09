import * as v from "valibot";

export interface ResourceSettings {
    sourcePath?: string;
    shouldPrefix?: boolean;
}

export const ResourceSettingsSchema = v.object({
    shouldPrefix: v.optional(v.boolean()),
    sourcePath: v.optional(v.string()),
});

export function parseResourceSettings(value: unknown): ResourceSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    const settings = { ...(value as Record<string, unknown>) };
    delete settings.prefix;

    if (settings.shouldPrefix === false) {
        return settings as ResourceSettings;
    }

    delete settings.shouldPrefix;
    return settings as ResourceSettings;
}

export function shouldPrefixResources(settings?: ResourceSettings | null): boolean {
    return settings?.shouldPrefix !== false;
}

export function mergeResourceSettings(current: unknown, patch: ResourceSettings): ResourceSettings {
    const next = parseResourceSettings(current);

    if ("shouldPrefix" in patch) {
        if (patch.shouldPrefix === false) {
            next.shouldPrefix = false;
        } else {
            delete next.shouldPrefix;
        }
    }

    return next;
}

export function prefixChangeWarning(
    currentShouldPrefix: boolean,
    deployedShouldPrefix?: boolean,
): string | undefined {
    if (deployedShouldPrefix === undefined || currentShouldPrefix === deployedShouldPrefix) {
        return undefined;
    }

    if (currentShouldPrefix) {
        return "The latest deployment ran without prefixing. The next deploy will prefix service and volume names, which Uncloud treats as new services and volumes.";
    }

    return "The latest deployment ran with prefixing. The next deploy will use unprefixed names, which Uncloud treats as new services and volumes.";
}
