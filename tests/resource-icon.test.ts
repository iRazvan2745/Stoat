import { describe, expect, it } from "vite-plus/test";

import {
    MAX_RESOURCE_ICON_LENGTH,
    normalizeResourceIcon,
    resolveResourceIcon,
    resourceIconFromFile,
    resourceIconSrc,
} from "#lib/domain/resources/icon";

describe("resourceIconSrc", () => {
    it("returns http(s) and relative URLs", () => {
        expect(resourceIconSrc("https://api.svgl.app/svg/postgresql.svg")).toBe(
            "https://api.svgl.app/svg/postgresql.svg",
        );
        expect(resourceIconSrc("/templates/postgresql/logo")).toBe("/templates/postgresql/logo");
    });

    it("keeps data URIs and wraps raw base64", () => {
        const dataUri = "data:image/svg+xml;base64,PHN2Zy8+";
        expect(resourceIconSrc(dataUri)).toBe(dataUri);
        expect(
            resourceIconSrc("PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg=="),
        ).toBe(
            "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
        );
        expect(resourceIconSrc("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")).toBe(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        );
    });

    it("rejects unsafe or empty values", () => {
        expect(resourceIconSrc(null)).toBeNull();
        expect(resourceIconSrc("")).toBeNull();
        expect(resourceIconSrc(`javascript${":"}alert(1)`)).toBeNull();
        expect(resourceIconSrc("//evil.example/icon.png")).toBeNull();
    });
});

describe("resolveResourceIcon", () => {
    it("prefers a stored icon over the postgres fallback", () => {
        expect(resolveResourceIcon("/custom.svg", "postgresql")).toBe("/custom.svg");
        expect(resolveResourceIcon(null, "postgresql")).toBe("/templates/postgresql/logo");
        expect(resolveResourceIcon(null, "compose")).toBeNull();
    });
});

describe("normalizeResourceIcon", () => {
    it("treats blank values as a cleared icon", () => {
        expect(normalizeResourceIcon(null)).toBeNull();
        expect(normalizeResourceIcon("")).toBeNull();
        expect(normalizeResourceIcon("   ")).toBeNull();
    });

    it("keeps safe URLs and data URIs", () => {
        expect(normalizeResourceIcon("https://api.svgl.app/svg/postgresql.svg")).toBe(
            "https://api.svgl.app/svg/postgresql.svg",
        );
        expect(normalizeResourceIcon("data:image/png;base64,iVBORw0KGgo")).toBe(
            "data:image/png;base64,iVBORw0KGgo",
        );
    });

    it("rejects unsafe values and oversized icons", () => {
        expect(() => normalizeResourceIcon(`javascript${":"}alert(1)`)).toThrow(
            "Invalid resource icon",
        );
        expect(() =>
            normalizeResourceIcon(`data:image/png;base64,${"A".repeat(MAX_RESOURCE_ICON_LENGTH)}`),
        ).toThrow("Resource icon is too large");
    });
});

describe("resourceIconFromFile", () => {
    it("encodes an image file as a data URI", async () => {
        const file = new File([new Uint8Array([137, 80, 78, 71])], "icon.png", {
            type: "image/png",
        });

        await expect(resourceIconFromFile(file)).resolves.toMatch(/^data:image\/png;base64,/u);
    });

    it("rejects an unsupported type", async () => {
        const file = new File(["not-an-image"], "icon.txt", {
            type: "text/plain",
        });

        await expect(resourceIconFromFile(file)).rejects.toThrow("PNG, JPEG, GIF, WebP, or SVG");
    });
});
