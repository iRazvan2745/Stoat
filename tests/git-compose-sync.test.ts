import { expect, it } from "vite-plus/test";
import YAML from "yaml";

import { formatComposeFile, unformatComposeFile } from "#lib/server/deployments/deployment-compose";
import {
    assertRepositoryPath,
    canonicalComposePath,
    exportGitCompose,
    inferComposeLocation,
    readGitCompose,
    syncDirection,
} from "#lib/server/git-sources/compose";

const raw = `# keep my jokes, clanker
services:
  web:
    image: nginx:1
    depends_on: [db]
    x-caddy: 'reverse_proxy {{upstreams "db" 80}}'
    volumes:
      - data:/data
      - ./config:/config
      - type: volume
        source: data
        target: /logs
  db:
    image: postgres:18
volumes:
  data:
`;
const service = {
    id: "svc",
    name: "Web",
    slug: "web-abc12",
    groupName: "Customer apps",
    icon: null,
    value: raw,
    settings: {},
};
const workspace = {
    id: "workspace",
    name: "Production",
    slug: "production-abc12",
    dataSourceId: "cluster",
};

it("round-trips formatting and metadata while retaining unformatted app names and comments", () => {
    const exported = exportGitCompose(service, workspace);
    expect(exported).toContain("web-abc12-web:");
    expect(exported).toContain("web-abc12-data:/data");
    expect(exported).toContain('upstreams "web-abc12-db"');
    const decoded = readGitCompose(exported.replace("nginx:1", "nginx:2"));
    expect(YAML.parse(decoded.raw)).toEqual(YAML.parse(raw.replace("nginx:1", "nginx:2")));
    expect(decoded.raw).toContain("# keep my jokes, clanker");
    expect(decoded.raw).not.toContain("x-stoat");
    expect(decoded.metadata).toMatchObject({
        serviceId: "svc",
        groupName: "Customer apps",
        shouldPrefix: true,
    });
});

it("removes exactly one prefix, including from mapping dependencies, while retaining bind mounts", () => {
    const compose = `services:\n  app-web:\n    depends_on:\n      db: { condition: service_started }\n    volumes:\n      - type: bind\n        source: app-files\n        target: /files\n  db:\n    image: postgres\n`;
    expect(YAML.parse(unformatComposeFile(formatComposeFile(compose, "app").yaml, "app"))).toEqual(
        YAML.parse(compose),
    );
});

it("does not infer a prefix for a plain repository Compose", () => {
    const decoded = readGitCompose(raw);
    expect(YAML.parse(decoded.raw)).toEqual(YAML.parse(raw));
    expect(decoded.metadata).toBeNull();
});

it("rejects collisions introduced by conflicting Git names", () => {
    expect(() => unformatComposeFile("services:\n  app-web: {}\n  web: {}\n", "app")).toThrow(
        "collide",
    );
});

it("maps workspace, group and service folders without allowing traversal", () => {
    const relativePath = canonicalComposePath(service, workspace);
    expect(relativePath).toBe("production-abc12/Customer%20apps/web-abc12/compose.yaml");
    expect(inferComposeLocation(relativePath, "Repository")).toEqual({
        workspaceName: "production-abc12",
        groupName: "Customer apps",
        serviceName: "web-abc12",
    });
    expect(canonicalComposePath({ ...service, groupName: "../ops" }, workspace)).toContain(
        "%2E%2E%2Fops",
    );
    for (const invalid of [
        "../compose.yaml",
        "/compose.yaml",
        ".git/config",
        "a/../compose.yaml",
        "a\\compose.yaml",
    ]) {
        expect(() => assertRepositoryPath(invalid)).toThrow("Invalid repository path");
    }
});

it("distinguishes local edits, Git edits and conflicts against separate baselines", () => {
    const base = {
        sourceId: "source",
        path: "compose.yaml",
        appHash: "app-base",
        repoHash: "repo-base",
    };
    expect(syncDirection("app-base", "repo-base", base)).toBe("unchanged");
    expect(syncDirection("app-edit", "repo-base", base)).toBe("push");
    expect(syncDirection("app-base", "repo-edit", base)).toBe("pull");
    expect(syncDirection("app-edit", "repo-edit", base)).toBe("conflict");
    expect(syncDirection("same", "same", base)).toBe("unchanged");
    expect(syncDirection("app-edit", "repo-edit", null)).toBe("conflict");
});
