import { describe, expect, it } from "vite-plus/test";

import { MAX_SERVICE_NAME_LENGTH, normalizeServiceName } from "#lib/service/identity";

describe("normalizeServiceName", () => {
  it("trims a valid name", () => {
    expect(normalizeServiceName("  Postgres  ")).toBe("Postgres");
  });

  it("rejects a blank name", () => {
    expect(() => normalizeServiceName("")).toThrow("Name is required");
    expect(() => normalizeServiceName("   ")).toThrow("Name is required");
  });

  it("rejects a name that is too long", () => {
    expect(() => normalizeServiceName("a".repeat(MAX_SERVICE_NAME_LENGTH + 1))).toThrow(
      "Name is too long",
    );
  });
});
