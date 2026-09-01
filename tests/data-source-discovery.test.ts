import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
    composeServiceName,
    discoverComposeFiles,
    repositoryName,
} from "#lib/server/data-sources/discovery";

describe("data source Compose discovery", () => {
    it("finds valid Compose files recursively and skips ignored directories", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "stoat-compose-discovery-"));

        try {
            await mkdir(path.join(root, "apps", "web"), { recursive: true });
            await mkdir(path.join(root, "node_modules", "ignored"), {
                recursive: true,
            });
            await writeFile(
                path.join(root, "apps", "web", "docker-compose.yml"),
                "services:\n  web:\n    image: nginx\n",
            );
            await writeFile(
                path.join(root, "node_modules", "ignored", "compose.yaml"),
                "services:\n  ignored:\n    image: nginx\n",
            );

            const result = await discoverComposeFiles(root);

            expect(result.files).toEqual([
                {
                    compose: "services:\n  web:\n    image: nginx\n",
                    relativePath: "apps/web/docker-compose.yml",
                    serviceCount: 1,
                },
            ]);
            expect(result.skipped).toEqual([]);
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it("reports invalid Compose candidates without stopping discovery", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "stoat-compose-discovery-"));

        try {
            await writeFile(path.join(root, "broken.yml"), "services:\n  web:\n");
            await writeFile(path.join(root, "docker-compose.yml"), "not-compose: true\n");

            const result = await discoverComposeFiles(root);

            expect(result.files).toEqual([]);
            expect(result.skipped).toEqual([
                {
                    reason: 'Compose file does not contain a non-empty "services" map',
                    relativePath: "docker-compose.yml",
                },
            ]);
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});

describe("discovered Compose names", () => {
    it("uses the containing directory for nested manifests", () => {
        expect(composeServiceName("forgejo/runners/docker-compose.yml")).toBe("runners");
        expect(composeServiceName("compose.yaml")).toBe("compose");
    });

    it("extracts repository names from common Git URL forms", () => {
        expect(repositoryName("ssh://git.example.com:2222/team/infrastructure.git")).toBe(
            "infrastructure",
        );
        expect(repositoryName("git@example.com:team/infrastructure.git")).toBe("infrastructure");
    });
});
