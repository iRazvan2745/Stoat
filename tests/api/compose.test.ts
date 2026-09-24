import { describe, expect, it } from "vite-plus/test";

import {
    formatComposeFile,
    resourceComposePrefix,
    rewriteComposeHostname,
    unformatComposeFile,
} from "../../packages/api/src/compose";

describe("formatComposeFile", () => {
    it("prefixes compose service names with the given prefix", () => {
        const formatted = formatComposeFile(
            `services:
  nginx:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-nginx"]);
        expect(formatted.serviceCount).toBe(1);
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-nginx:");
        expect(formatted.yaml).toContain("image: nginx");
    });

    it("prefixes every service in a compose file", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
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
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual([
            "a1b2c3d4-e5f6a7b8-seafile",
            "a1b2c3d4-e5f6a7b8-seadoc",
            "a1b2c3d4-e5f6a7b8-db",
            "a1b2c3d4-e5f6a7b8-redis",
        ]);
        expect(formatted.yaml).toContain(
            'reverse_proxy {{upstreams "a1b2c3d4-e5f6a7b8-seadoc" 80}}',
        );
        expect(formatted.yaml).toContain("reverse_proxy {{upstreams 80}}");
        expect(formatted.yaml).toContain(
            "a1b2c3d4-e5f6a7b8-db:\n        condition: service_healthy",
        );
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
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
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-postgres:");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-postgres_data:/var/lib/postgresql");
        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-logs");
        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-postgres_data:/mu);
        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-logs:/mu);
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
        expect(() => formatComposeFile("services: [", "a1b2c3d4-e5f6a7b8")).toThrow(
            "Invalid compose YAML",
        );
    });

    it("rejects compose files without a services map", () => {
        expect(() => formatComposeFile("version: '3'\n", "a1b2c3d4-e5f6a7b8")).toThrow(
            'Compose must contain a "services" map',
        );
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
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-myconfig:/mu);
        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-longconfig:/mu);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-myconfig");
        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-longconfig");
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
                "a1b2c3d4-e5f6a7b8",
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
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-app_config");
        expect(formatted.yaml).not.toContain("source: app_config");
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-app_data:/data");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).not.toMatch(/a1b2c3d4-e5f6a7b8-a1b2c3d4-e5f6a7b8/u);
        // Unformatting restores the anchor body as well.
        expect(unformatComposeFile(formatted.yaml, "a1b2c3d4-e5f6a7b8")).toContain(
            "source: app_config",
        );
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
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- 3000/https");
        expect(formatted.yaml).toContain("configs: not-a-compose-list");
    });
});

describe("resourceComposePrefix", () => {
    const projectId = "a1b2c3d4-1111-4222-8333-444455556666";
    const resourceId = "e5f6a7b8-7777-4888-8999-000011112222";

    it("builds the prefix from the first 8 of the project and resource uuids", () => {
        expect(resourceComposePrefix({ projectId, id: resourceId, settings: null })).toBe(
            "a1b2c3d4-e5f6a7b8",
        );
    });

    it("prefixes on by default when settings are missing or unrelated", () => {
        expect(resourceComposePrefix({ projectId, id: resourceId, settings: {} })).toBe(
            "a1b2c3d4-e5f6a7b8",
        );
        expect(
            resourceComposePrefix({
                projectId,
                id: resourceId,
                settings: { prefixNames: true },
            }),
        ).toBe("a1b2c3d4-e5f6a7b8");
    });

    it("returns undefined when the resource opted out of prefixing", () => {
        expect(
            resourceComposePrefix({
                projectId,
                id: resourceId,
                settings: { prefixNames: false },
            }),
        ).toBeUndefined();
    });

    it("round-trips through format and unformat", () => {
        const prefix = resourceComposePrefix({
            projectId,
            id: resourceId,
            settings: null,
        });

        const spec = `services:
  web:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres
`;

        const formatted = formatComposeFile(spec, prefix);
        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        const raw = unformatComposeFile(formatted.yaml, prefix);
        expect(formatComposeFile(raw).serviceNames).toEqual(["web", "db"]);
    });
});

describe("formatComposeFile service references", () => {
    it("prefixes links, extends, volumes_from, and network_mode service refs", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    links:
      - db
      - cache:redis
    extends:
      file: common.yaml
      service: base
    volumes_from:
      - data
      - logs:ro
    network_mode: "service:proxy"
  db:
    image: postgres
  cache:
    image: redis
  base:
    image: nginx
  data:
    image: busybox
  logs:
    image: busybox
  proxy:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-cache:redis");
        expect(formatted.yaml).toContain("service: a1b2c3d4-e5f6a7b8-base");
        expect(formatted.yaml).toContain("file: common.yaml");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-logs:ro");
        expect(formatted.yaml).toContain('network_mode: "service:a1b2c3d4-e5f6a7b8-proxy"');
    });

    it("leaves non-service network modes alone", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    network_mode: host
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("network_mode: host");
    });

    it("prefixes top-level secrets and short/long service refs", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    secrets:
      - mysecret
      - source: longsecret
        target: /run/secrets/long
secrets:
  mysecret:
    file: ./secret.txt
  longsecret:
    external: true
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-mysecret:/mu);
        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-longsecret:/mu);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-mysecret");
        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-longsecret");
        expect(formatted.yaml).not.toMatch(/^ {2}mysecret:/mu);
    });

    it("rejects invalid service secrets entries", () => {
        expect(() =>
            formatComposeFile(
                `services:
  web:
    image: nginx
    secrets:
      - 123
secrets:
  mysecret:
    external: true
`,
                "a1b2c3d4-e5f6a7b8",
            ),
        ).toThrow("Invalid secrets entry");
    });
});

describe("formatComposeFile environment", () => {
    it("rewrites service hostnames in list and map environment values", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - DATABASE_URL=postgres://stoat:secret@db:5432/app
      - REDIS_URL=redis://:pass@cache:6379/0
      - DB_HOST=db
      - APP_URL=https://stoat.example.com
      - GREETING=hello-db
      - BARE_KEY
    depends_on:
      - db
  worker:
    image: nginx
    environment:
      DATABASE_URL: postgres://stoat:secret@db:5432/app
      PORT: 3000
      DEBUG: true
  db:
    image: postgres
  cache:
    image: redis
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain(
            "DATABASE_URL=postgres://stoat:secret@a1b2c3d4-e5f6a7b8-db:5432/app",
        );
        expect(formatted.yaml).toContain("REDIS_URL=redis://:pass@a1b2c3d4-e5f6a7b8-cache:6379/0");
        expect(formatted.yaml).toContain("DB_HOST=a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("APP_URL=https://stoat.example.com");
        expect(formatted.yaml).toContain("GREETING=hello-db");
        expect(formatted.yaml).toContain("BARE_KEY");
        expect(formatted.yaml).toContain(
            "DATABASE_URL: postgres://stoat:secret@a1b2c3d4-e5f6a7b8-db:5432/app",
        );
        expect(formatted.yaml).toContain("PORT: 3000");
    });

    it("restores environment hostnames when unformatting", () => {
        const spec = `services:
  web:
    image: nginx
    environment:
      - DATABASE_URL=postgres://stoat:secret@db:5432/app
`;

        const formatted = formatComposeFile(spec, "a1b2c3d4-e5f6a7b8");
        const raw = unformatComposeFile(formatted.yaml, "a1b2c3d4-e5f6a7b8");
        expect(raw).toContain("DATABASE_URL=postgres://stoat:secret@db:5432/app");
    });

    it("leaves environment untouched when no prefix is given", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - DATABASE_URL=postgres://stoat:secret@db:5432/app
  db:
    image: postgres
`,
        );

        expect(formatted.yaml).toContain("DATABASE_URL=postgres://stoat:secret@db:5432/app");
    });
});

describe("rewriteComposeHostname", () => {
    const names = new Set(["db", "cache"]);
    const rename = (name: string) => `p-${name}`;

    it("rewrites exact whole values and URL hosts", () => {
        expect(rewriteComposeHostname("db", names, rename)).toBe("p-db");
        expect(rewriteComposeHostname("postgres://u:p@db:5432/app", names, rename)).toBe(
            "postgres://u:p@p-db:5432/app",
        );
        expect(rewriteComposeHostname("http://cache:3000/x?y=db#z", names, rename)).toBe(
            "http://p-cache:3000/x?y=db#z",
        );
    });

    it("ignores substrings, external hosts, and userinfo matches", () => {
        expect(rewriteComposeHostname("mydb", names, rename)).toBe("mydb");
        expect(rewriteComposeHostname("hello-db", names, rename)).toBe("hello-db");
        expect(rewriteComposeHostname("https://db.example.com", names, rename)).toBe(
            "https://db.example.com",
        );
        expect(rewriteComposeHostname("postgres://db:pw@external:5432/app", names, rename)).toBe(
            "postgres://db:pw@external:5432/app",
        );
        expect(rewriteComposeHostname("not a url", names, rename)).toBe("not a url");
    });
});

describe("resourceComposePrefix edge cases", () => {
    const projectId = "a1b2c3d4-1111-4222-8333-444455556666";
    const resourceId = "e5f6a7b8-7777-4888-8999-000011112222";

    it("treats undefined settings and non-object settings as prefix-on", () => {
        expect(resourceComposePrefix({ projectId, id: resourceId, settings: undefined })).toBe(
            "a1b2c3d4-e5f6a7b8",
        );
        expect(resourceComposePrefix({ projectId, id: resourceId, settings: "nope" })).toBe(
            "a1b2c3d4-e5f6a7b8",
        );
        expect(resourceComposePrefix({ projectId, id: resourceId, settings: 42 })).toBe(
            "a1b2c3d4-e5f6a7b8",
        );
        expect(
            resourceComposePrefix({ projectId, id: resourceId, settings: ["prefixNames"] }),
        ).toBe("a1b2c3d4-e5f6a7b8");
    });

    it("only an explicit false opts out; other falsy values stay prefixed", () => {
        for (const prefixNames of [true, 0, "", null, "false"]) {
            expect(
                resourceComposePrefix({ projectId, id: resourceId, settings: { prefixNames } }),
            ).toBe("a1b2c3d4-e5f6a7b8");
        }
    });

    it("slices ids shorter than 8 characters without padding", () => {
        expect(resourceComposePrefix({ projectId: "abc", id: "def", settings: null })).toBe(
            "abc-def",
        );
    });

    it("preserves the original casing of id segments", () => {
        expect(
            resourceComposePrefix({
                projectId: "A1B2C3D4-1111-4222-8333-444455556666",
                id: "E5F6A7B8-7777-4888-8999-000011112222",
                settings: null,
            }),
        ).toBe("A1B2C3D4-E5F6A7B8");
    });
});

describe("formatComposeFile validation", () => {
    it("accepts an empty services map with zero services", () => {
        const formatted = formatComposeFile("services: {}\n", "p");
        expect(formatted.serviceCount).toBe(0);
        expect(formatted.serviceNames).toEqual([]);
    });

    it("rejects an empty document and scalar documents", () => {
        expect(() => formatComposeFile("", "p")).toThrow('Compose must contain a "services" map');
        expect(() => formatComposeFile("just a string\n", "p")).toThrow(
            'Compose must contain a "services" map',
        );
    });

    it("rejects null, sequence, and scalar services values", () => {
        expect(() => formatComposeFile("services:\n", "p")).toThrow(
            'Compose must contain a "services" map',
        );
        expect(() => formatComposeFile("services: []\n", "p")).toThrow(
            'Compose must contain a "services" map',
        );
        expect(() => formatComposeFile("services: nope\n", "p")).toThrow(
            'Compose must contain a "services" map',
        );
    });

    it("rejects non-string service names", () => {
        expect(() => formatComposeFile("services:\n  123:\n    image: x\n", "p")).toThrow(
            "Invalid service name",
        );
        expect(() => formatComposeFile("services:\n  true:\n    image: x\n", "p")).toThrow(
            "Invalid service name",
        );
    });

    it("treats an empty-string prefix as no prefix", () => {
        const formatted = formatComposeFile("services:\n  web:\n    image: nginx\n", "");
        expect(formatted.serviceNames).toEqual(["web"]);
    });
});

describe("formatComposeFile service naming quirks", () => {
    it("keeps file order in serviceNames", () => {
        const formatted = formatComposeFile(
            "services:\n  zed:\n    image: x\n  mid:\n    image: x\n  abc:\n    image: x\n",
            "p",
        );

        expect(formatted.serviceNames).toEqual(["p-zed", "p-mid", "p-abc"]);
    });

    it("renames services with null, scalar, or sequence bodies without crashing", () => {
        const formatted = formatComposeFile(
            "services:\n  empty:\n  scalar: just-a-string\n  seq:\n    - a\n",
            "p",
        );

        expect(formatted.serviceNames).toEqual(["p-empty", "p-scalar", "p-seq"]);
    });

    it("double-prefixes names that already carry the prefix", () => {
        const formatted = formatComposeFile("services:\n  p-web:\n    image: nginx\n", "p");
        expect(formatted.serviceNames).toEqual(["p-p-web"]);
    });

    it("preserves comments and unrelated top-level and service keys", () => {
        const formatted = formatComposeFile(
            '# leading comment\nservices:\n  web: # trailing comment\n    image: nginx # image comment\n    restart: unless-stopped\n    ports:\n      - "3000:3000"\nnetworks:\n  front: {}\n',
            "p",
        );

        expect(formatted.yaml).toContain("# leading comment");
        expect(formatted.yaml).toContain("# trailing comment");
        expect(formatted.yaml).toContain("# image comment");
        expect(formatted.yaml).toContain("restart: unless-stopped");
        expect(formatted.yaml).toContain("3000:3000");
        expect(formatted.yaml).toContain("front:");
        expect(formatted.serviceNames).toEqual(["p-web"]);
    });
});

describe("formatComposeFile volumes short syntax", () => {
    it("leaves a bare named short entry without colon as-is while renaming the top-level volume", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - data
volumes:
  data:
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- data");
        expect(formatted.yaml).toContain("  a1b2c3d4-e5f6a7b8-data:");
        expect(formatted.yaml).not.toContain("- a1b2c3d4-e5f6a7b8-data");
    });

    it("leaves anonymous container-only short entries untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - /data
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- /data");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-/data");
    });

    it("leaves anonymous short entries with a mode suffix untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - /data:ro
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- /data:ro");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-/data");
    });

    it("leaves relative and home-directory bind mounts untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - ./x:/c
      - ../x:/c
      - ~/x:/c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- ./x:/c");
        expect(formatted.yaml).toContain("- ../x:/c");
        expect(formatted.yaml).toContain("- ~/x:/c");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-./x");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-../x");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-~/x");
    });

    it("leaves absolute host bind mounts untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - /host:/c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- /host:/c");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-/host");
    });

    it("prefixes only the drive letter of a Windows forward-slash short entry", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - C:/d:/c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-C:/d:/c");
    });

    it("prefixes only the drive letter of a Windows backslash short entry", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - C:\\d:/c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-C:");
    });

    it("does not crash on an empty-string short entry", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - ""
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("volumes:");
    });

    it("preserves the :ro suffix when renaming a named short volume", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - data:/c:ro
volumes:
  data:
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data:/c:ro");
        expect(formatted.yaml).toContain("  a1b2c3d4-e5f6a7b8-data:");
    });

    it("preserves the :rw suffix when renaming a named short volume", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - data:/c:rw
volumes:
  data:
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data:/c:rw");
        expect(formatted.yaml).toContain("  a1b2c3d4-e5f6a7b8-data:");
    });
});

describe("formatComposeFile volumes long syntax", () => {
    it("does not crash on a long type volume entry with no source", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - type: volume
        target: /c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("type: volume");
        expect(formatted.yaml).toContain("target: /c");
    });

    it("renames a long entry with no type but a named source", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - source: data
        target: /c
volumes:
  data:
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-data");
        expect(formatted.yaml).toContain("  a1b2c3d4-e5f6a7b8-data:");
    });

    it("leaves a long bind entry with a named-looking source untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - type: bind
        source: data
        target: /c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("type: bind");
        expect(formatted.yaml).toContain("source: data");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-data");
    });

    it("leaves a long tmpfs entry with a named-looking source untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - type: tmpfs
        source: data
        target: /c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("type: tmpfs");
        expect(formatted.yaml).toContain("source: data");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-data");
    });

    it("leaves a long npipe entry with a named-looking source untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - type: npipe
        source: data
        target: /c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("type: npipe");
        expect(formatted.yaml).toContain("source: data");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-data");
    });

    it("leaves a long cluster entry with a named-looking source untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - type: cluster
        source: data
        target: /c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("type: cluster");
        expect(formatted.yaml).toContain("source: data");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-data");
    });

    it("leaves a long image entry with a named-looking source untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - type: image
        source: data
        target: /c
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("type: image");
        expect(formatted.yaml).toContain("source: data");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-data");
    });
});

describe("formatComposeFile volumes weird shapes", () => {
    it("ignores a top-level volumes sequence without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - data:/c
volumes:
  - data
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data:/c");
        expect(formatted.yaml).toContain("volumes:\n  - data");
    });

    it("ignores a top-level volumes scalar without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes:
      - data:/c
volumes: foo
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data:/c");
        expect(formatted.yaml).toContain("volumes: foo");
    });

    it("skips a top-level volume with a numeric key while renaming string keys", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
volumes:
  123:
    driver: local
  data:
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("123:");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-123");
        expect(formatted.yaml).toContain("  a1b2c3d4-e5f6a7b8-data:");
    });

    it("does not crash when service volumes is a plain map", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes: {foo: bar}
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("foo: bar");
    });
});

describe("formatComposeFile service configs scalar and map forms", () => {
    it("renames scalar string service configs", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    configs: myconfig
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("configs: a1b2c3d4-e5f6a7b8-myconfig");
    });

    it("renames map form service configs source", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    configs:
      source: myconfig
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-myconfig");
    });

    it("leaves long configs entry without source untouched without throwing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    configs:
      - target: /etc/app.conf
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("target: /etc/app.conf");
        expect(formatted.yaml).not.toContain("source: a1b2c3d4-e5f6a7b8");
    });

    it("throws on numeric entry in service configs sequence", () => {
        expect(() =>
            formatComposeFile(
                `services:
  web:
    image: nginx
    configs:
      - 5
`,
                "a1b2c3d4-e5f6a7b8",
            ),
        ).toThrow("Invalid configs entry");
    });

    it("throws on scalar numeric service configs", () => {
        expect(() =>
            formatComposeFile(
                `services:
  web:
    image: nginx
    configs: 5
`,
                "a1b2c3d4-e5f6a7b8",
            ),
        ).toThrow("Invalid configs entry");
    });
});

describe("formatComposeFile top-level configs sequence", () => {
    it("ignores top-level configs sequence without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
configs:
  - myconfig
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- myconfig");
        expect(formatted.yaml).not.toContain("a1b2c3d4-e5f6a7b8-myconfig");
    });
});

describe("formatComposeFile secrets", () => {
    it("prefixes scalar, long, and top-level secrets", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    secrets: mysecret
  worker:
    image: nginx
    secrets:
      - source: othersecret
        target: /run/secrets/other
secrets:
  mysecret:
    file: ./my.txt
  othersecret:
    file: ./other.txt
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual([
            "a1b2c3d4-e5f6a7b8-web",
            "a1b2c3d4-e5f6a7b8-worker",
        ]);
        expect(formatted.yaml).toContain("secrets: a1b2c3d4-e5f6a7b8-mysecret");
        expect(formatted.yaml).toContain("source: a1b2c3d4-e5f6a7b8-othersecret");
        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-mysecret:/mu);
        expect(formatted.yaml).toMatch(/^ {2}a1b2c3d4-e5f6a7b8-othersecret:/mu);
    });

    it("throws on numeric entry in service secrets sequence", () => {
        expect(() =>
            formatComposeFile(
                `services:
  web:
    image: nginx
    secrets:
      - 5
`,
                "a1b2c3d4-e5f6a7b8",
            ),
        ).toThrow("Invalid secrets entry");
    });
});

describe("formatComposeFile depends_on edge cases", () => {
    it("ignores scalar string depends_on", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    depends_on: db
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("depends_on: db");
        expect(formatted.yaml).not.toContain("depends_on: a1b2c3d4-e5f6a7b8-db");
    });

    it("skips numeric items in depends_on sequence without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    depends_on:
      - db
      - 5
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("- 5");
    });

    it("skips numeric keys in depends_on map", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    depends_on:
      db:
        condition: service_started
      5:
        condition: service_started
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain(
            "a1b2c3d4-e5f6a7b8-db:\n        condition: service_started",
        );
        expect(formatted.yaml).toContain("5:");
    });
});

describe("formatComposeFile links edge cases", () => {
    it("ignores map and scalar links", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    links: db
  worker:
    image: nginx
    links:
      db: db
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual([
            "a1b2c3d4-e5f6a7b8-web",
            "a1b2c3d4-e5f6a7b8-worker",
            "a1b2c3d4-e5f6a7b8-db",
        ]);
        expect(formatted.yaml).toContain("links: db");
        expect(formatted.yaml).toContain("db: db");
        expect(formatted.yaml).not.toContain("links: a1b2c3d4-e5f6a7b8-db");
    });

    it("skips non-string items in links sequence without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    links:
      - db
      - 5
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("- 5");
    });

    it("renames only the first segment of multi-colon links", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    links:
      - a:b:c
  a:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-a:b:c");
    });
});

describe("formatComposeFile extends edge cases", () => {
    it("ignores string extends", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    extends: db
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("extends: db");
        expect(formatted.yaml).not.toContain("extends: a1b2c3d4-e5f6a7b8-db");
    });

    it("leaves extends map without service untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    extends:
      file: common.yml
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("file: common.yml");
    });

    it("leaves extends service with non-string value untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    extends:
      service: 5
      file: common.yml
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("service: 5");
        expect(formatted.yaml).toContain("file: common.yml");
    });
});

describe("formatComposeFile volumes_from edge cases", () => {
    it("ignores non-sequence volumes_from", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes_from: db
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("volumes_from: db");
        expect(formatted.yaml).not.toContain("volumes_from: a1b2c3d4-e5f6a7b8-db");
    });

    it("skips map items in volumes_from sequence", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    volumes_from:
      - db
      - source: other
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("source: other");
        expect(formatted.yaml).not.toContain("source: a1b2c3d4-e5f6a7b8-other");
    });
});

describe("formatComposeFile network_mode edge cases", () => {
    it("leaves container, none, and non-string network_mode untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    network_mode: container:db
  worker:
    image: nginx
    network_mode: none
  other:
    image: nginx
    network_mode: 5
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual([
            "a1b2c3d4-e5f6a7b8-web",
            "a1b2c3d4-e5f6a7b8-worker",
            "a1b2c3d4-e5f6a7b8-other",
            "a1b2c3d4-e5f6a7b8-db",
        ]);
        expect(formatted.yaml).toContain("network_mode: container:db");
        expect(formatted.yaml).not.toContain("network_mode: container:a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("network_mode: none");
        expect(formatted.yaml).toContain("network_mode: 5");
    });

    it("prefixes service network_mode", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    network_mode: service:db
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("network_mode: service:a1b2c3d4-e5f6a7b8-db");
    });
});

describe("formatComposeFile x-caddy", () => {
    it("renames two different upstreams references in one block", () => {
        const formatted = formatComposeFile(
            `services:
  gateway:
    image: caddy
    x-caddy: |
      reverse_proxy {{upstreams "web" 80}} {{upstreams "api" 3000}}
  web:
    image: nginx
  api:
    image: node
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual([
            "a1b2c3d4-e5f6a7b8-gateway",
            "a1b2c3d4-e5f6a7b8-web",
            "a1b2c3d4-e5f6a7b8-api",
        ]);
        expect(formatted.yaml).toContain('{{upstreams "a1b2c3d4-e5f6a7b8-web" 80}}');
        expect(formatted.yaml).toContain('{{upstreams "a1b2c3d4-e5f6a7b8-api" 3000}}');
    });

    it("renames upstreams with irregular whitespace", () => {
        const formatted = formatComposeFile(
            `services:
  gateway:
    image: caddy
    x-caddy: |
      reverse_proxy {{  upstreams   "web"  80 }}
  web:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual([
            "a1b2c3d4-e5f6a7b8-gateway",
            "a1b2c3d4-e5f6a7b8-web",
        ]);
        expect(formatted.yaml).toContain('{{  upstreams   "a1b2c3d4-e5f6a7b8-web"');
    });

    it("renames x-caddy correctly across sequential calls with different prefixes", () => {
        const compose = `services:
  gateway:
    image: caddy
    x-caddy: |
      reverse_proxy {{upstreams "web" 80}}
  web:
    image: nginx
`;

        const first = formatComposeFile(compose, "a1b2c3d4-e5f6a7b8");
        const second = formatComposeFile(compose, "ffffffff-11111111");

        expect(first.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-gateway", "a1b2c3d4-e5f6a7b8-web"]);
        expect(second.serviceNames).toEqual(["ffffffff-11111111-gateway", "ffffffff-11111111-web"]);
        expect(first.yaml).toContain('{{upstreams "a1b2c3d4-e5f6a7b8-web" 80}}');
        expect(second.yaml).toContain('{{upstreams "ffffffff-11111111-web" 80}}');
        expect(second.yaml).not.toContain("a1b2c3d4-e5f6a7b8");
    });

    it("leaves non-string x-caddy untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    x-caddy:
      upstream: web
      port: 80
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("upstream: web");
        expect(formatted.yaml).not.toContain("upstream: a1b2c3d4-e5f6a7b8-web");
    });

    it("renames an upstream naming a service not defined in the file", () => {
        const formatted = formatComposeFile(
            `services:
  gateway:
    image: caddy
    x-caddy: |
      reverse_proxy {{upstreams "ghost" 80}}
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-gateway"]);
        expect(formatted.yaml).toContain('{{upstreams "a1b2c3d4-e5f6a7b8-ghost" 80}}');
    });
});

describe("formatComposeFile YAML anchors", () => {
    it("renames volumes depends_on and configs from a single scalar alias merge", () => {
        const formatted = formatComposeFile(
            `x-base: &base
  volumes:
    - data:/data
  depends_on:
    - db
  configs:
    - myconfig
services:
  web:
    image: nginx
    <<: *base
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data:/data");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-myconfig");
    });

    it("renames fragments from both aliases in a sequence merge", () => {
        const formatted = formatComposeFile(
            `x-a: &a
  volumes:
    - data-a:/data
x-b: &b
  depends_on:
    - db
services:
  web:
    image: nginx
    <<: [*a, *b]
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data-a:/data");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
    });

    it("renames nested merges where the anchor target itself merges another anchor", () => {
        const formatted = formatComposeFile(
            `x-other: &other
  volumes:
    - data-other:/data
x-base: &base
  <<: *other
  depends_on:
    - db
services:
  web:
    image: nginx
    <<: *base
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-data-other:/data");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");
    });

    it("does not crash on an alias to a scalar anchor", () => {
        const formatted = formatComposeFile(
            `x-val: &val hello
services:
  web:
    image: nginx
    <<: *val
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-web:");
        expect(formatted.yaml).toContain("*val");
    });

    it("leaves a defined-but-never-merged anchor completely untouched", () => {
        const formatted = formatComposeFile(
            `x-unused: &unused
  volumes:
    - data:/data
  depends_on:
    - db
services:
  web:
    image: nginx
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-web:");
        expect(formatted.yaml).toContain("- data:/data");
        expect(formatted.yaml).toContain("- db");
        expect(formatted.yaml).not.toContain("- a1b2c3d4-e5f6a7b8-data:/data");
    });

    it("handles a service combining its own keys with a merge", () => {
        const formatted = formatComposeFile(
            `x-base: &base
  volumes:
    - base-data:/data
services:
  web:
    image: nginx
    volumes:
      - own-data:/data
    <<: *base
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web"]);
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-own-data:/data");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-base-data:/data");
    });
});

describe("rewriteComposeHostname", () => {
    it("rewrites an uppercase scheme when the host is a service name", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("HTTP://db:3000", names, rename)).toBe("HTTP://p-db:3000");
    });

    it("rewrites a URL with no path", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("http://db", names, rename)).toBe("http://p-db");
    });

    it("rewrites a URL with an empty port", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("http://db:/x", names, rename)).toBe("http://p-db:/x");
    });

    it("leaves IPv6 literals untouched", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("http://[::1]:3000/", names, rename)).toBe(
            "http://[::1]:3000/",
        );
    });

    it("rewrites only the host when the password contains an at-sign", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("postgres://u:p@ss@db:5432/x", names, rename)).toBe(
            "postgres://u:p@ss@p-db:5432/x",
        );
    });

    it("preserves a query containing the service name while rewriting the host", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("http://db:3000/x?target=db", names, rename)).toBe(
            "http://p-db:3000/x?target=db",
        );
    });

    it("leaves host and port without a scheme untouched", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("db:5432", names, rename)).toBe("db:5432");
    });

    it("leaves a leading-space value untouched", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname(" db", names, rename)).toBe(" db");
    });

    it("is case sensitive for exact values and URL hosts", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("DB", names, rename)).toBe("DB");
        expect(rewriteComposeHostname("http://DB:3000/", names, rename)).toBe("http://DB:3000/");
    });

    it("leaves file URLs untouched", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("file:///etc/passwd", names, rename)).toBe(
            "file:///etc/passwd",
        );
    });

    it("leaves values without a scheme separator untouched", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("mailto:foo@bar", names, rename)).toBe("mailto:foo@bar");
    });

    it("rewrites only the first host when a value contains two URLs", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("http://db:3000?next=http://db:4000", names, rename)).toBe(
            "http://p-db:3000?next=http://db:4000",
        );
    });

    it("does not double rewrite values that already carry the prefix", () => {
        const names = new Set(["db", "cache"]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("p-db", names, rename)).toBe("p-db");
        expect(rewriteComposeHostname("http://p-db:3000/", names, rename)).toBe(
            "http://p-db:3000/",
        );
    });

    it("returns any value as-is when the names set is empty", () => {
        const names = new Set<string>([]);
        const rename = (name: string) => "p-" + name;

        expect(rewriteComposeHostname("db", names, rename)).toBe("db");
        expect(rewriteComposeHostname("http://db:3000/x", names, rename)).toBe("http://db:3000/x");
    });
});

describe("formatComposeFile environment values", () => {
    it("leaves an empty list value untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - EMPTY=
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- EMPTY=");
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-db:");
    });

    it("leaves extra equals in a list value untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - KEY=a=b
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- KEY=a=b");
    });

    it("leaves bare list entries without equals untouched", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - db
      - KEY
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- db");
        expect(formatted.yaml).toContain("- KEY");
    });

    it("skips numeric boolean null and map items in the list without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - 123
      - true
      - null
      - FOO: bar
      - KEEP=keep
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("123");
        expect(formatted.yaml).toContain("true");
        expect(formatted.yaml).toContain("null");
        expect(formatted.yaml).toContain("FOO");
        expect(formatted.yaml).toContain("KEEP=keep");
    });

    it("rewrites exact and URL values in list form", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      - DB_HOST=db
      - DATABASE_URL=postgres://u:p@ss@db:5432/app
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("- DB_HOST=a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("postgres://u:p@ss@a1b2c3d4-e5f6a7b8-db:5432/app");
    });

    it("skips null and nested-map values in map form while rewriting strings", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment:
      DB_HOST: db
      DATABASE_URL: http://db:3000/x?target=db
      EMPTY: null
      NESTED:
        inner: db
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("DB_HOST: a1b2c3d4-e5f6a7b8-db");
        expect(formatted.yaml).toContain("http://a1b2c3d4-e5f6a7b8-db:3000/x?target=db");
        expect(formatted.yaml).toContain("EMPTY: null");
        expect(formatted.yaml).toContain("inner: db");
    });

    it("ignores a scalar string environment without crashing", () => {
        const formatted = formatComposeFile(
            `services:
  web:
    image: nginx
    environment: FOO=bar
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(formatted.yaml).toContain("FOO=bar");
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-web:");
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-db:");
    });
});

describe("unformatComposeFile", () => {
    it("returns raw service names when no prefix is given", () => {
        const raw = unformatComposeFile(
            `services:
  web:
    image: nginx
  db:
    image: postgres
`,
        );

        expect(raw).toContain("  web:");
        expect(raw).toContain("  db:");
        expect(raw).toContain("image: nginx");
        expect(raw).toContain("image: postgres");
    });

    it("leaves service names unchanged when they lack the prefix", () => {
        const raw = unformatComposeFile(
            `services:
  web:
    image: nginx
  db:
    image: postgres
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(raw).toContain("  web:");
        expect(raw).toContain("  db:");
        expect(raw).not.toContain("a1b2c3d4-e5f6a7b8-");
    });

    it("strips a leading prefix from service names", () => {
        const raw = unformatComposeFile(
            `services:
  a1b2c3d4-e5f6a7b8-web:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(raw).toContain("  web:");
        expect(raw).not.toContain("a1b2c3d4-e5f6a7b8-");
    });

    it("leaves names with the prefix in non-leading position untouched", () => {
        const raw = unformatComposeFile(
            `services:
  xa1b2c3d4-e5f6a7b8-web:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(raw).toContain("  xa1b2c3d4-e5f6a7b8-web:");
        expect(raw).not.toContain("  web:");
    });

    it("leaves a service named exactly the prefix untouched", () => {
        const raw = unformatComposeFile(
            `services:
  a1b2c3d4-e5f6a7b8:
    image: nginx
`,
            "a1b2c3d4-e5f6a7b8",
        );

        expect(raw).toContain("  a1b2c3d4-e5f6a7b8:");
    });

    it("throws when two names collide after removing the prefix", () => {
        expect(() =>
            unformatComposeFile(
                `services:
  p-x:
    image: nginx
  x:
    image: postgres
`,
                "p",
            ),
        ).toThrow("Compose names collide after removing the Stoat prefix");
    });

    it("rejects invalid YAML", () => {
        expect(() => unformatComposeFile("services: [", "a1b2c3d4-e5f6a7b8")).toThrow(
            "Invalid compose YAML",
        );
    });

    it("rejects compose files without a services map", () => {
        expect(() => unformatComposeFile("version: '3'\n", "a1b2c3d4-e5f6a7b8")).toThrow(
            'Compose must contain a "services" map',
        );
    });
});

describe("compose format/unformat round-trip", () => {
    it("restores service names, volumes, depends_on forms, and env hosts", () => {
        const spec = `services:
  web:
    image: nginx
    depends_on:
      - db
    volumes:
      - web_data:/data
    environment:
      - DATABASE_URL=postgres://stoat:secret@db:5432/app
  db:
    image: postgres
    depends_on:
      web:
        condition: service_started
    volumes:
      - db_data:/var/lib/postgresql
volumes:
  web_data:
  db_data:
`;

        const formatted = formatComposeFile(spec, "a1b2c3d4-e5f6a7b8");

        expect(formatted.serviceNames).toEqual(["a1b2c3d4-e5f6a7b8-web", "a1b2c3d4-e5f6a7b8-db"]);
        expect(formatted.yaml).toContain("a1b2c3d4-e5f6a7b8-web:");
        expect(formatted.yaml).toContain("- a1b2c3d4-e5f6a7b8-db");

        const raw = unformatComposeFile(formatted.yaml, "a1b2c3d4-e5f6a7b8");

        expect(raw).toContain("  web:");
        expect(raw).toContain("  db:");
        expect(raw).toContain("  web_data:");
        expect(raw).toContain("  db_data:");
        expect(raw).toContain("- web_data:/data");
        expect(raw).toContain("- db_data:/var/lib/postgresql");
        expect(raw).toContain("      - db\n");
        expect(raw).toContain("web:\n        condition: service_started");
        expect(raw).toContain("DATABASE_URL=postgres://stoat:secret@db:5432/app");
        expect(raw).not.toContain("a1b2c3d4-e5f6a7b8-");
    });
});
