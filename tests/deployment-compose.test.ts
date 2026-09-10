import { describe, expect, it } from "vite-plus/test";

import {
    applyEnvironmentVariables,
    formatComposeFile,
    inlineComposeConfigs,
    inlineEnvironmentVariables,
    isUnsafeConfigPath,
    listComposeConfigReferences,
    MAX_CONFIG_FILE_BYTES,
    unformatComposeFile,
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

    it("prefixes depends_on references and x-caddy upstreams", () => {
        const formatted = formatComposeFile(
            `services:
  seafile:
    image: seafileltd/seafile-pro-mc
    x-caddy: |
      files.example.com {
        handle_path /sdoc-server/* {
          reverse_proxy {{upstreams "seadoc" 80}}
        }
        reverse_proxy {{upstreams 80}}
      }
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
  seadoc:
    image: seafileltd/sdoc-server
    depends_on:
      - db
  db:
    image: mariadb
  redis:
    image: redis
`,
            "sf-abc12",
        );

        expect(formatted.serviceNames).toEqual([
            "sf-abc12-seafile",
            "sf-abc12-seadoc",
            "sf-abc12-db",
            "sf-abc12-redis",
        ]);
        expect(formatted.yaml).toContain('reverse_proxy {{upstreams "sf-abc12-seadoc" 80}}');
        expect(formatted.yaml).toContain("reverse_proxy {{upstreams 80}}");
        expect(formatted.yaml).toContain("sf-abc12-db:\n        condition: service_healthy");
        expect(formatted.yaml).toContain("- sf-abc12-db");
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

    it("replaces existing keys in an environment list instead of duplicating them", () => {
        const yaml = applyEnvironmentVariables(
            `services:
  web:
    image: nginx
    environment:
      - FOO=old
      - KEEP=yes
`,
            [{ name: "FOO", value: "new" }],
        );

        expect(yaml).toContain("FOO=new");
        expect(yaml).toContain("KEEP=yes");
        expect(yaml).not.toContain("FOO=old");
        expect(yaml.match(/FOO=/gu)?.length).toBe(1);
    });

    it("replaces bare KEY entries in an environment list", () => {
        const yaml = applyEnvironmentVariables(
            `services:
  web:
    image: nginx
    environment:
      - FOO
      - KEEP=yes
`,
            [{ name: "FOO", value: "new" }],
        );

        expect(yaml).toContain("FOO=new");
        expect(yaml).toContain("KEEP=yes");
        expect(yaml.match(/FOO/gu)?.length).toBe(1);
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

describe("formatComposeFile configs", () => {
    it("prefixes top-level configs and short/long service refs", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    configs:
      - myconfig
      - source: longconfig
        target: /etc/long.conf
configs:
  myconfig:
    file: ./my.txt
  longconfig:
    content: hello
`,
            "app-abc12",
        );

        expect(formatted.yaml).toMatch(/^ {2}app-abc12-myconfig:/mu);
        expect(formatted.yaml).toMatch(/^ {2}app-abc12-longconfig:/mu);
        expect(formatted.yaml).toContain("- app-abc12-myconfig");
        expect(formatted.yaml).toContain("source: app-abc12-longconfig");
        expect(formatted.yaml).not.toMatch(/^ {2}myconfig:/mu);
    });

    it("leaves configs unchanged when no prefix is given", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    configs:
      - myconfig
      - source: longconfig
        target: /etc/long.conf
configs:
  myconfig:
    file: ./my.txt
  longconfig:
    content: hello
`,
        );

        expect(formatted.yaml).toContain("- myconfig");
        expect(formatted.yaml).toContain("source: longconfig");
        expect(formatted.yaml).toMatch(/^ {2}myconfig:/mu);
        expect(formatted.yaml).toMatch(/^ {2}longconfig:/mu);
    });

    it("rejects invalid service configs entries", () => {
        expect(() =>
            formatComposeFile(
                `services:
  web:
    image: nginx
    configs:
      - 123
configs:
  myconfig:
    content: hi
`,
                "app-abc12",
            ),
        ).toThrow("Invalid configs entry");
    });

    it("prefixes configs inside anchors merged into services, exactly once", () => {
        const formatted = formatComposeFile(
            `x-base: &base
  image: nginx
  configs:
    - source: app_config
      target: /etc/app.conf
  volumes:
    - app_data:/data
  depends_on:
    - db
services:
  web:
    <<: *base
  worker:
    <<: *base
  db:
    image: postgres
configs:
  app_config:
    content: hi
volumes:
  app_data:
`,
            "app-abc12",
        );

        expect(formatted.yaml).toContain("source: app-abc12-app_config");
        expect(formatted.yaml).not.toContain("source: app_config");
        expect(formatted.yaml).toContain("app-abc12-app_data:/data");
        expect(formatted.yaml).toContain("- app-abc12-db");
        expect(formatted.yaml).not.toMatch(/app-abc12-app-abc12/u);
        // Unformatting restores the anchor body as well.
        expect(unformatComposeFile(formatted.yaml, "app-abc12")).toContain("source: app_config");
    });

    it("leaves unrelated x-* extensions untouched", () => {
        const formatted = formatComposeFile(
            `x-ports:
  - 3000/https
x-custom:
  configs: not-a-compose-list
services:
  web:
    image: nginx
`,
            "app-abc12",
        );

        expect(formatted.yaml).toContain("- 3000/https");
        expect(formatted.yaml).toContain("configs: not-a-compose-list");
    });
});

describe("isUnsafeConfigPath", () => {
    it("rejects empty, absolute, backslash, dot segments, and .git", () => {
        expect(isUnsafeConfigPath("")).toBe(true);
        expect(isUnsafeConfigPath("/abs/path")).toBe(true);
        expect(isUnsafeConfigPath("a\\b")).toBe(true);
        expect(isUnsafeConfigPath("../a")).toBe(true);
        expect(isUnsafeConfigPath("a/../b")).toBe(true);
        expect(isUnsafeConfigPath("a/./b")).toBe(true);
        expect(isUnsafeConfigPath("a//b")).toBe(true);
        expect(isUnsafeConfigPath(".git")).toBe(true);
        expect(isUnsafeConfigPath("a/.git/b")).toBe(true);
        expect(isUnsafeConfigPath(".")).toBe(true);
        expect(isUnsafeConfigPath("..")).toBe(true);
    });

    it("allows plain relative paths", () => {
        expect(isUnsafeConfigPath("my.txt")).toBe(false);
        expect(isUnsafeConfigPath("./a")).toBe(false);
        expect(isUnsafeConfigPath("./party.conf")).toBe(false);
        expect(isUnsafeConfigPath("dir/my.txt")).toBe(false);
        expect(isUnsafeConfigPath("a/.gitignore")).toBe(false);
    });
});

describe("listComposeConfigReferences", () => {
    it("lists file, content, and external flags", () => {
        const refs = listComposeConfigReferences(
            `services:
  web:
    image: nginx
configs:
  from_file:
    file: ./a.txt
  from_content:
    content: hello
  from_external:
    external: true
`,
        );

        expect(refs).toEqual([
            {
                config: "from_file",
                file: "./a.txt",
                hasContent: false,
                hasExternal: false,
            },
            {
                config: "from_content",
                file: null,
                hasContent: true,
                hasExternal: false,
            },
            {
                config: "from_external",
                file: null,
                hasContent: false,
                hasExternal: true,
            },
        ]);
    });

    it("returns [] when there are no top-level configs", () => {
        expect(
            listComposeConfigReferences(`services:
  web:
    image: nginx
`),
        ).toEqual([]);
    });

    it("returns [] when configs is not a map", () => {
        expect(
            listComposeConfigReferences(`services:
  web:
    image: nginx
configs:
  - a
`),
        ).toEqual([]);
    });

    it("rejects invalid YAML", () => {
        expect(() => listComposeConfigReferences("configs: [")).toThrow("Invalid compose YAML");
    });
});

describe("inlineComposeConfigs", () => {
    it("inlines file: into content:", () => {
        const out = inlineComposeConfigs(
            `services:
  web:
    image: nginx
    configs:
      - myconfig
configs:
  myconfig:
    file: hello.txt
`,
            (p) => (p === "hello.txt" ? "hello world" : null),
        );

        expect(out).toContain("content:");
        expect(out).toContain("hello world");
        expect(out).not.toContain("file:");
    });

    it("resolves ./prefixed paths against the normalized key", () => {
        const seen: string[] = [];
        const out = inlineComposeConfigs(
            `services:
  web:
    image: nginx
    configs:
      - myconfig
configs:
  myconfig:
    file: ./party.conf
`,
            (p) => {
                seen.push(p);
                return p === "party.conf" ? "party content" : null;
            },
        );

        expect(seen).toEqual(["party.conf"]);
        expect(out).toContain("party content");
        expect(out).not.toContain("file:");
    });

    it("passes through content, external, and environment", () => {
        const out = inlineComposeConfigs(
            `services:
  web:
    image: nginx
configs:
  keep_content:
    content: hi
  keep_external:
    external: true
  keep_env:
    environment:
      FOO: bar
`,
            () => {
                throw new Error("should not resolve");
            },
        );

        expect(out).toContain("content: hi");
        expect(out).toContain("external: true");
        expect(out).toContain("FOO: bar");
    });

    it("throws a helpful error when the file is missing", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
configs:
  myconfig:
    file: missing.txt
`,
                () => null,
            ),
        ).toThrow("Files page");
    });

    it("uses the custom compose path in the missing-file error", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
configs:
  myconfig:
    file: missing.txt
`,
                () => null,
                { composePath: "docker-compose.yml" },
            ),
        ).toThrow("docker-compose.yml");
    });

    it("rejects unsafe paths", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
configs:
  myconfig:
    file: ../secret.txt
`,
                () => "x",
            ),
        ).toThrow("unsafe file path");
    });

    it("rejects binary content", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
configs:
  myconfig:
    file: bin.dat
`,
                () => "a\0b",
            ),
        ).toThrow("looks binary");
    });

    it("rejects oversize content", () => {
        const big = "a".repeat(MAX_CONFIG_FILE_BYTES + 1);
        expect(MAX_CONFIG_FILE_BYTES).toBe(262_144);
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
configs:
  myconfig:
    file: big.txt
`,
                () => big,
            ),
        ).toThrow("exceeds 256 KiB");
    });

    it("rejects service references without a top-level entry", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
    configs:
      - ghost
configs:
  real:
    content: hi
`,
                () => null,
            ),
        ).toThrow("has no top-level configs entry");
    });

    it("rejects long-syntax references without a top-level entry", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
    configs:
      - source: ghost
        target: /etc/ghost
configs:
  real:
    content: hi
`,
                () => null,
            ),
        ).toThrow("has no top-level configs entry");
    });

    it("rejects configs without file/content/environment/external", () => {
        expect(() =>
            inlineComposeConfigs(
                `services:
  web:
    image: nginx
configs:
  myconfig:
    name: custom
`,
                () => null,
            ),
        ).toThrow("must declare file:");
    });

    it("returns compose unchanged when there are no top-level configs", () => {
        const input = `services:
  web:
    image: nginx
`;
        expect(inlineComposeConfigs(input, () => null)).toBe(input);
    });

    it("preserves anchors and merge keys", () => {
        const input = `x-copyparty: &copyparty
  image: copyparty/ac:latest
  configs:
    - source: appcfg
      target: /cfg.conf
services:
  a:
    <<: *copyparty
  b:
    <<: *copyparty
configs:
  appcfg:
    file: app.conf
`;
        const out = inlineComposeConfigs(input, (p) => (p === "app.conf" ? "cfg-body" : null));

        expect(out).toContain("&copyparty");
        expect(out).toContain("*copyparty");
        expect(out).toContain("<<:");
        expect(out).toContain("cfg-body");
        expect(out).not.toContain("file: app.conf");
    });
});
