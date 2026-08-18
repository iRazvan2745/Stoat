import { describe, expect, it } from "vite-plus/test";

import { formatComposeFile } from "./deployment-compose";

describe("formatComposeFile", () => {
  it("prefixes compose service names with the service slug", () => {
    const formatted = formatComposeFile(
      `services:
  nginx:
    image: nginx
    x-ports:
      - 25001:80/https
`,
      "nginx-f7gzq",
    );

    expect(formatted.serviceNames).toEqual(["nginx-f7gzq-nginx"]);
    expect(formatted.serviceCount).toBe(1);
    expect(formatted.yaml).toContain("nginx-f7gzq-nginx:");
    expect(formatted.yaml).toContain("image: nginx");
    expect(formatted.yaml).toContain("25001:80/https");
  });

  it("prefixes every service in a compose file", () => {
    const formatted = formatComposeFile(
      `services:
  web:
    image: nginx
  db:
    image: postgres
`,
      "app-abc12",
    );

    expect(formatted.serviceNames).toEqual(["app-abc12-web", "app-abc12-db"]);
  });

  it("rejects invalid YAML", () => {
    expect(() => formatComposeFile("services: [", "slug")).toThrow("Invalid compose YAML");
  });

  it("rejects compose files without a services map", () => {
    expect(() => formatComposeFile("version: '3'\n", "slug")).toThrow(
      'Compose must contain a "services" map',
    );
  });
});
