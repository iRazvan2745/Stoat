import * as v from "valibot";

export interface ServiceSettings {
  shouldPrefix?: boolean;
}

export const ServiceSettingsSchema = v.object({
  shouldPrefix: v.optional(v.boolean()),
});

export function parseServiceSettings(value: unknown): ServiceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const settings = { ...(value as Record<string, unknown>) };
  delete settings.prefix;

  if (settings.shouldPrefix === false) {
    return settings as ServiceSettings;
  }

  delete settings.shouldPrefix;
  return settings as ServiceSettings;
}

export function shouldPrefixServices(settings?: ServiceSettings | null): boolean {
  return settings?.shouldPrefix !== false;
}

export function mergeServiceSettings(current: unknown, patch: ServiceSettings): ServiceSettings {
  const next = parseServiceSettings(current);

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
