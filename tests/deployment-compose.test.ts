import { describe, expect, it } from "vite-plus/test";

import {
  applyEnvironmentVariables,
  formatComposeFile,
  inlineEnvironmentVariables,
} from "#lib/server/deployments/deployment-compose";

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

  it("prefixes named volumes and volume mounts", () => {
    const formatted = formatComposeFile(
      `services:
  postgres:
    image: postgres:18
    volumes:
      - postgres_data:/var/lib/postgresql
      - type: volume
        source: logs
        target: /var/log
      - type: bind
        source: /host/config
        target: /etc/config
      - /anonymous
volumes:
  postgres_data:
  logs:
`,
      "db-abc12",
    );

    expect(formatted.yaml).toContain("db-abc12-postgres:");
    expect(formatted.yaml).toContain("- db-abc12-postgres_data:/var/lib/postgresql");
    expect(formatted.yaml).toContain("source: db-abc12-logs");
    expect(formatted.yaml).toMatch(/^ {2}db-abc12-postgres_data:/mu);
    expect(formatted.yaml).toMatch(/^ {2}db-abc12-logs:/mu);
    expect(formatted.yaml).toContain("source: /host/config");
    expect(formatted.yaml).toContain("- /anonymous");
    expect(formatted.yaml).not.toMatch(/^\s+- postgres_data:/mu);
    expect(formatted.yaml).not.toMatch(/^ {2}postgres_data:/mu);
  });

  it("leaves compose service names and volumes unchanged when no prefix is given", () => {
    const formatted = formatComposeFile(
      `services:
  nginx:
    image: nginx
    volumes:
      - nginx_data:/var/lib/nginx
volumes:
  nginx_data:
`,
    );

    expect(formatted.serviceNames).toEqual(["nginx"]);
    expect(formatted.yaml).toContain("nginx:");
    expect(formatted.yaml).toContain("nginx_data:/var/lib/nginx");
    expect(formatted.yaml).toContain("nginx_data:");
    expect(formatted.yaml).not.toContain("nginx-nginx:");
    expect(formatted.yaml).not.toContain("nginx-nginx_data");
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

describe("applyEnvironmentVariables", () => {
  it("points services at a .env file when compose has no environment block", () => {
    const yaml = applyEnvironmentVariables(
      `services:
  web:
    image: nginx
`,
      [{ name: "FOO", value: "bar" }],
    );

    expect(yaml).toContain("env_file: .env");
    expect(yaml).not.toContain("environment:");
    expect(yaml).not.toContain("FOO: bar");
  });

  it("keeps an existing env_file and adds .env when needed", () => {
    const yaml = applyEnvironmentVariables(
      `services:
  web:
    image: nginx
    env_file: .env.production
`,
      [{ name: "FOO", value: "bar" }],
    );

    expect(yaml).toContain(".env.production");
    expect(yaml).toContain(".env");
    expect(yaml).not.toContain("environment:");
  });

  it("does not duplicate .env when env_file already points at it", () => {
    const yaml = applyEnvironmentVariables(
      `services:
  web:
    image: nginx
    env_file: .env
`,
      [{ name: "FOO", value: "bar" }],
    );

    expect(yaml.match(/\.env/gu)?.length).toBe(1);
    expect(yaml).not.toContain("environment:");
  });

  it("overlays values onto an existing environment map", () => {
    const yaml = applyEnvironmentVariables(
      `services:
  web:
    image: nginx
    environment:
      FOO: old
      KEEP: yes
`,
      [{ name: "FOO", value: "new" }],
    );

    expect(yaml).toContain("FOO: new");
    expect(yaml).toContain("KEEP: yes");
    expect(yaml).not.toContain("FOO: old");
    expect(yaml).not.toContain("env_file");
  });

  it("appends KEY=value entries onto an existing environment list", () => {
    const yaml = applyEnvironmentVariables(
      `services:
  web:
    image: nginx
    environment:
      - FOO=old
`,
      [{ name: "BAR", value: "baz" }],
    );

    expect(yaml).toContain("FOO=old");
    expect(yaml).toContain("BAR=baz");
    expect(yaml).not.toContain("env_file");
  });
});

describe("inlineEnvironmentVariables", () => {
  it("adds a map of environment variables to each service", () => {
    const yaml = inlineEnvironmentVariables(
      `services:
  web:
    image: nginx
`,
      [{ name: "FOO", value: "bar" }],
    );

    expect(yaml).toContain("FOO: bar");
    expect(yaml).toContain("environment:");
  });

  it("replaces env_file with inlined environment variables", () => {
    const yaml = inlineEnvironmentVariables(
      `services:
  web:
    image: nginx
    env_file: .env
`,
      [{ name: "FOO", value: "bar" }],
    );

    expect(yaml).toContain("FOO: bar");
    expect(yaml).not.toContain("env_file");
  });
});
