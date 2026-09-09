import { describe, expect, it } from "vite-plus/test";

import {
    mergeResourceSettings,
    parseResourceSettings,
    prefixChangeWarning,
    shouldPrefixResources,
} from "#lib/domain/resources/settings";

describe("parseResourceSettings", () => {
    it("returns an empty object for missing or invalid values", () => {
        expect(parseResourceSettings(null)).toEqual({});
        expect(parseResourceSettings("nope")).toEqual({});
        expect(parseResourceSettings([])).toEqual({});
        expect(parseResourceSettings({ shouldPrefix: "yes" })).toEqual({});
    });

    it("keeps an explicit off flag and unknown future keys", () => {
        expect(
            parseResourceSettings({
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
            parseResourceSettings({
                extra: true,
                prefix: "prod",
                shouldPrefix: true,
            }),
        ).toEqual({ extra: true });
    });
});

describe("shouldPrefixResources", () => {
    it("defaults to on", () => {
        expect(shouldPrefixResources()).toBe(true);
        expect(shouldPrefixResources({})).toBe(true);
        expect(shouldPrefixResources({ shouldPrefix: true })).toBe(true);
    });

    it("is off only when set to false", () => {
        expect(shouldPrefixResources({ shouldPrefix: false })).toBe(false);
    });
});

describe("mergeResourceSettings", () => {
    it("stores an explicit off without dropping other settings", () => {
        expect(mergeResourceSettings({ extra: 1 }, { shouldPrefix: false })).toEqual({
            extra: 1,
            shouldPrefix: false,
        });
    });

    it("omits the flag when turning prefixing back on", () => {
        expect(
            mergeResourceSettings({ extra: 1, shouldPrefix: false }, { shouldPrefix: true }),
        ).toEqual({ extra: 1 });
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
