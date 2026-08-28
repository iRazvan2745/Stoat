import { describe, expect, it } from "vite-plus/test";

import {
  MAX_SERVICE_ICON_LENGTH,
  normalizeServiceIcon,
  resolveServiceIcon,
  serviceIconFromFile,
  serviceIconSrc,
} from "#lib/service/icon";

describe("serviceIconSrc", () => {
  it("returns http(s) and relative URLs", () => {
    expect(serviceIconSrc("https://api.svgl.app/svg/postgresql.svg")).toBe(
      "https://api.svgl.app/svg/postgresql.svg",
    );
    expect(serviceIconSrc("/templates/postgresql/logo")).toBe("/templates/postgresql/logo");
  });

  it("keeps data URIs and wraps raw base64", () => {
    const dataUri = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(serviceIconSrc(dataUri)).toBe(dataUri);
    expect(serviceIconSrc("PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==")).toBe(
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
    );
    expect(serviceIconSrc("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    );
  });

  it("rejects unsafe or empty values", () => {
    expect(serviceIconSrc(null)).toBeNull();
    expect(serviceIconSrc("")).toBeNull();
    expect(serviceIconSrc(`javascript${":"}alert(1)`)).toBeNull();
    expect(serviceIconSrc("//evil.example/icon.png")).toBeNull();
  });
});

describe("resolveServiceIcon", () => {
  it("prefers a stored icon over the postgres fallback", () => {
    expect(resolveServiceIcon("/custom.svg", "postgresql")).toBe("/custom.svg");
    expect(resolveServiceIcon(null, "postgresql")).toBe("/templates/postgresql/logo");
    expect(resolveServiceIcon(null, "compose")).toBeNull();
  });
});

describe("normalizeServiceIcon", () => {
  it("treats blank values as a cleared icon", () => {
    expect(normalizeServiceIcon(null)).toBeNull();
    expect(normalizeServiceIcon("")).toBeNull();
    expect(normalizeServiceIcon("   ")).toBeNull();
  });

  it("keeps safe URLs and data URIs", () => {
    expect(normalizeServiceIcon("https://api.svgl.app/svg/postgresql.svg")).toBe(
      "https://api.svgl.app/svg/postgresql.svg",
    );
    expect(normalizeServiceIcon("data:image/png;base64,iVBORw0KGgo")).toBe(
      "data:image/png;base64,iVBORw0KGgo",
    );
  });

  it("rejects unsafe values and oversized icons", () => {
    expect(() => normalizeServiceIcon(`javascript${":"}alert(1)`)).toThrow("Invalid service icon");
    expect(() =>
      normalizeServiceIcon(`data:image/png;base64,${"A".repeat(MAX_SERVICE_ICON_LENGTH)}`),
    ).toThrow("Service icon is too large");
  });
});

describe("serviceIconFromFile", () => {
  it("encodes an image file as a data URI", async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "icon.png", {
      type: "image/png",
    });

    await expect(serviceIconFromFile(file)).resolves.toMatch(/^data:image\/png;base64,/u);
  });

  it("rejects an unsupported type", async () => {
    const file = new File(["not-an-image"], "icon.txt", {
      type: "text/plain",
    });

    await expect(serviceIconFromFile(file)).rejects.toThrow("PNG, JPEG, GIF, WebP, or SVG");
  });
});
