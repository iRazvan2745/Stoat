import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";

import {
    MAX_RESOURCE_FILE_BYTES,
    ResourceFileInputSchema,
    assertSafeResourceFileContent,
    assertSafeResourceFilePath,
    normalizeResourceFilePath,
    resourceFileByteLength,
} from "#lib/domain/resources/files";
import {
    mergeResourceSettings,
    parseResourceSettings,
    shouldSyncResourceFilesToGit,
} from "#lib/domain/resources/settings";

describe("normalizeResourceFilePath", () => {
    it("strips leading ./ segments", () => {
        expect(normalizeResourceFilePath("./compose.yaml")).toBe("compose.yaml");
        expect(normalizeResourceFilePath("././config/app.env")).toBe("config/app.env");
    });

    it("collapses redundant segments", () => {
        expect(normalizeResourceFilePath("config//app.env")).toBe("config/app.env");
        expect(normalizeResourceFilePath("config/./app.env")).toBe("config/app.env");
    });
});

describe("assertSafeResourceFilePath", () => {
    it("accepts simple relative paths", () => {
        expect(assertSafeResourceFilePath("compose.yaml")).toBe("compose.yaml");
        expect(assertSafeResourceFilePath("config/app.env")).toBe("config/app.env");
        expect(assertSafeResourceFilePath("a-b_c.d/e-f_g.h")).toBe("a-b_c.d/e-f_g.h");
    });

    it("rejects absolute paths, backslashes, and whitespace padding", () => {
        expect(() => assertSafeResourceFilePath("/compose.yaml")).toThrow("relative");
        expect(() => assertSafeResourceFilePath("config\\app.env")).toThrow("backslash");
        expect(() => assertSafeResourceFilePath(" compose.yaml")).toThrow("whitespace");
        expect(() => assertSafeResourceFilePath("")).toThrow("required");
    });

    it("rejects traversal and .git segments", () => {
        expect(() => assertSafeResourceFilePath("../escape")).toThrow("..");
        expect(() => assertSafeResourceFilePath("a/../../b")).toThrow("..");
        expect(() => assertSafeResourceFilePath(".git/config")).toThrow(".git");
        expect(() => assertSafeResourceFilePath("a/.git/b")).toThrow(".git");
    });

    it("rejects non-normalized and overlong paths", () => {
        expect(() => assertSafeResourceFilePath("./compose.yaml")).toThrow("normalized");
        expect(() => assertSafeResourceFilePath("a//b")).toThrow("normalized");
        expect(() => assertSafeResourceFilePath(`${"a".repeat(129)}`)).toThrow("too long");
        expect(() => assertSafeResourceFilePath("has space.yaml")).toThrow("invalid characters");
    });
});

describe("resourceFileByteLength", () => {
    it("counts UTF-8 bytes, not characters", () => {
        expect(resourceFileByteLength("abc")).toBe(3);
        expect(resourceFileByteLength("é")).toBe(2);
    });
});

describe("assertSafeResourceFileContent", () => {
    it("accepts text within the limit", () => {
        expect(assertSafeResourceFileContent("services: {}")).toBe("services: {}");
        expect(assertSafeResourceFileContent("a".repeat(MAX_RESOURCE_FILE_BYTES)).length).toBe(
            MAX_RESOURCE_FILE_BYTES,
        );
    });

    it("rejects NUL bytes and oversized content", () => {
        expect(() => assertSafeResourceFileContent("a\0b")).toThrow("binary");
        expect(() =>
            assertSafeResourceFileContent("a".repeat(MAX_RESOURCE_FILE_BYTES + 1)),
        ).toThrow("too large");
    });
});

describe("ResourceFileInputSchema", () => {
    it("accepts a valid file input", () => {
        expect(
            v.safeParse(ResourceFileInputSchema, {
                content: "services: {}",
                path: "compose.yaml",
            }).success,
        ).toBe(true);
    });

    it("rejects unsafe paths and binary content", () => {
        expect(
            v.safeParse(ResourceFileInputSchema, {
                content: "x",
                path: "../escape",
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(ResourceFileInputSchema, {
                content: "a\0b",
                path: "compose.yaml",
            }).success,
        ).toBe(false);
    });
});

describe("syncFilesToGit setting", () => {
    it("defaults to syncing", () => {
        expect(shouldSyncResourceFilesToGit()).toBe(true);
        expect(shouldSyncResourceFilesToGit({})).toBe(true);
        expect(shouldSyncResourceFilesToGit({ syncFilesToGit: true })).toBe(true);
        expect(shouldSyncResourceFilesToGit({ syncFilesToGit: false })).toBe(false);
    });

    it("parse keeps an explicit off and drops a default-on flag", () => {
        expect(parseResourceSettings({ syncFilesToGit: false })).toEqual({
            syncFilesToGit: false,
        });
        expect(parseResourceSettings({ syncFilesToGit: true })).toEqual({});
    });

    it("merge persists false and deletes the key when re-enabled", () => {
        expect(mergeResourceSettings({}, { syncFilesToGit: false })).toEqual({
            syncFilesToGit: false,
        });
        expect(mergeResourceSettings({ syncFilesToGit: false }, { syncFilesToGit: true })).toEqual(
            {},
        );
        expect(
            mergeResourceSettings(
                { shouldPrefix: false, syncFilesToGit: false },
                { syncFilesToGit: false },
            ),
        ).toEqual({ shouldPrefix: false, syncFilesToGit: false });
    });
});
