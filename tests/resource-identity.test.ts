import { describe, expect, it } from "vite-plus/test";

import { MAX_RESOURCE_NAME_LENGTH, normalizeResourceName } from "#lib/domain/resources/identity";

describe("normalizeResourceName", () => {
    it("trims a valid name", () => {
        expect(normalizeResourceName("  Postgres  ")).toBe("Postgres");
    });

    it("rejects a blank name", () => {
        expect(() => normalizeResourceName("")).toThrow("Name is required");
        expect(() => normalizeResourceName("   ")).toThrow("Name is required");
    });

    it("rejects a name that is too long", () => {
        expect(() => normalizeResourceName("a".repeat(MAX_RESOURCE_NAME_LENGTH + 1))).toThrow(
            "Name is too long",
        );
    });
});
