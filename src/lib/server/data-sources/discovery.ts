// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import YAML, { isMap } from "yaml";

const COMPOSE_FILE_NAMES = new Set([
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
    ".git",
    ".svelte-kit",
    ".vite",
    "coverage",
    "dist",
    "node_modules",
]);

export interface DiscoveredComposeFile {
    compose: string;
    relativePath: string;
    serviceCount: number;
}

export interface SkippedComposeFile {
    reason: string;
    relativePath: string;
}

export interface ComposeDiscovery {
    files: DiscoveredComposeFile[];
    skipped: SkippedComposeFile[];
}

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

export const composeServiceName = (relativePath: string): string => {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const directory = path.posix.dirname(normalizedPath);

    if (directory !== ".") {
        return path.posix.basename(directory);
    }

    return path.posix.basename(normalizedPath, path.posix.extname(normalizedPath));
};

export const repositoryName = (repoUrl: string): string => {
    const withoutQuery = repoUrl.trim().split(/[?#]/u, 1)[0] ?? repoUrl.trim();
    const segments = withoutQuery.replaceAll(/\/+$/gu, "").split(/[/:]/u).filter(Boolean);
    const name = segments.at(-1)?.replace(/\.git$/iu, "");

    return name || "Repository";
};

const visitDirectory = async (
    rootPath: string,
    currentPath: string,
    files: DiscoveredComposeFile[],
    skipped: SkippedComposeFile[],
): Promise<void> => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory()) {
            if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
                continue;
            }

            await visitDirectory(rootPath, path.join(currentPath, entry.name), files, skipped);
            continue;
        }

        if (!entry.isFile() || !COMPOSE_FILE_NAMES.has(entry.name)) {
            continue;
        }

        const filePath = path.join(currentPath, entry.name);
        const relativePath = toPosixPath(path.relative(rootPath, filePath));

        let compose: string;

        try {
            compose = await fs.readFile(filePath, "utf-8");
        } catch (error) {
            skipped.push({
                reason: error instanceof Error ? error.message : "Unable to read the Compose file",
                relativePath,
            });
            continue;
        }

        const document = YAML.parseDocument(compose);

        if (document.errors.length > 0) {
            skipped.push({
                reason: document.errors[0]?.message ?? "Invalid YAML",
                relativePath,
            });
            continue;
        }

        const composeServices = document.get("services", true);

        if (!isMap(composeServices) || composeServices.items.length === 0) {
            skipped.push({
                reason: 'Compose file does not contain a non-empty "services" map',
                relativePath,
            });
            continue;
        }

        files.push({
            compose,
            relativePath,
            serviceCount: composeServices.items.length,
        });
    }
};

export const discoverComposeFiles = async (rootPath: string): Promise<ComposeDiscovery> => {
    const root = path.resolve(rootPath);
    const files: DiscoveredComposeFile[] = [];
    const skipped: SkippedComposeFile[] = [];

    await visitDirectory(root, root, files, skipped);

    return { files, skipped };
};
