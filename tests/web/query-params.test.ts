import { describe, expect, it } from "vite-plus/test";
import { deploymentIdParser, listPageSize, pageParser } from "../../apps/web/src/lib/query-params";

describe("page query parameter", () => {
    it("restores positive pages and serializes them", () => {
        expect(pageParser.defaultValue).toBe(1);

        for (const page of [1, 2, 42, 1000]) {
            expect(pageParser.parse(pageParser.serialize(page))).toBe(page);
        }

        expect(pageParser.parse("003")).toBe(3);
        expect((pageParser.parse("3")! - 1) * listPageSize).toBe(50);
    });

    it.each([
        "",
        "0",
        "-1",
        "1.5",
        "3junk",
        "1e2",
        " 2",
        "Infinity",
        "NaN",
        "9007199254740991",
        "9007199254740992",
    ])("rejects invalid or unsafe page %j", (value) => {
        expect(pageParser.parse(value)).toBeNull();
    });
});

describe("deployment query parameter", () => {
    it("restores an ID without serializing a deployment object", () => {
        const id = "e1e52ef9-975d-4282-881b-c58cc202c611";
        expect(deploymentIdParser.parse(id)).toBe(id);
        expect(deploymentIdParser.serialize(id)).toBe(id);
        expect(deploymentIdParser.parse(id.toUpperCase())).toBe(id.toUpperCase());
    });

    it.each([
        "",
        "undefined",
        "deployment-1",
        "../../deployments",
        "e1e52ef9-975d-4282-881b-c58cc202c611junk",
    ])("rejects malformed deployment ID %j", (value) => {
        expect(deploymentIdParser.parse(value)).toBeNull();
    });
});
