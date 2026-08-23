import { describe, expect, it } from "vite-plus/test";

import { resolveServiceIcon, serviceIconSrc } from "#lib/service/icon";

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
