import { describe, expect, it } from "vite-plus/test";

import {
  mergeServiceSettings,
  parseServiceSettings,
  prefixChangeWarning,
  shouldPrefixServices,
} from "#lib/service-settings";

describe("parseServiceSettings", () => {
  it("returns an empty object for missing or invalid values", () => {
    expect(parseServiceSettings(null)).toEqual({});
    expect(parseServiceSettings("nope")).toEqual({});
    expect(parseServiceSettings([])).toEqual({});
    expect(parseServiceSettings({ shouldPrefix: "yes" })).toEqual({});
  });

  it("keeps an explicit off flag and unknown future keys", () => {
    expect(
      parseServiceSettings({
        extra: true,
        shouldPrefix: false,
      }),
    ).toEqual({
      extra: true,
      shouldPrefix: false,
    });
  });

  it("drops a leftover prefix string and a default-on flag", () => {
    expect(
      parseServiceSettings({
        extra: true,
        prefix: "prod",
        shouldPrefix: true,
      }),
    ).toEqual({ extra: true });
  });
});

describe("shouldPrefixServices", () => {
  it("defaults to on", () => {
    expect(shouldPrefixServices()).toBe(true);
    expect(shouldPrefixServices({})).toBe(true);
    expect(shouldPrefixServices({ shouldPrefix: true })).toBe(true);
  });

  it("is off only when set to false", () => {
    expect(shouldPrefixServices({ shouldPrefix: false })).toBe(false);
  });
});

describe("mergeServiceSettings", () => {
  it("stores an explicit off without dropping other settings", () => {
    expect(mergeServiceSettings({ extra: 1 }, { shouldPrefix: false })).toEqual({
      extra: 1,
      shouldPrefix: false,
    });
  });

  it("omits the flag when turning prefixing back on", () => {
    expect(mergeServiceSettings({ extra: 1, shouldPrefix: false }, { shouldPrefix: true })).toEqual(
      { extra: 1 },
    );
  });
});

describe("prefixChangeWarning", () => {
  it("is silent when there is no successful deployment", () => {
    expect(prefixChangeWarning(true)).toBeUndefined();
    expect(prefixChangeWarning(false)).toBeUndefined();
  });

  it("is silent when the toggle matches the latest deployment", () => {
    expect(prefixChangeWarning(true, true)).toBeUndefined();
    expect(prefixChangeWarning(false, false)).toBeUndefined();
  });

  it("warns when enabling prefixing after an unprefixed deploy", () => {
    expect(prefixChangeWarning(true, false)).toContain("without prefixing");
  });

  it("warns when disabling prefixing after a prefixed deploy", () => {
    expect(prefixChangeWarning(false, true)).toContain("with prefixing");
  });
});
