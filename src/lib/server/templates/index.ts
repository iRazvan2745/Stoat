// oxlint-disable func-style no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { parseEnvFile } from "#lib/domain/environment";
import { ensureSvgNamespace, svglIconUrl } from "#lib/domain/templates";
import type { ResourceTemplate, TemplateManifest, TemplateVersion } from "#lib/domain/templates";

const TemplateManifestSchema = v.object({
    description: v.pipe(v.string(), v.minLength(1)),
    icon: v.optional(v.pipe(v.string(), v.minLength(1))),
    name: v.pipe(v.string(), v.minLength(1)),
    tags: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
    type: v.pipe(v.string(), v.minLength(1)),
});

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const LOGO_FILES = ["logo.svg", "logo.png"] as const;
const COMPOSE_FILES = ["compose.yaml", "compose.yml"] as const;
const LOGO_MEDIA_TYPES = {
    "logo.png": "image/png",
    "logo.svg": "image/svg+xml",
} as const;

export const defaultTemplatesRoot = (): string => path.join(process.cwd(), "templates");

export function assertSafeTemplateSegment(value: string, label: string): void {
    if (!SAFE_SEGMENT.test(value)) {
        throw new Error(`Invalid ${label}`);
    }
}

const isDirectory = async (filePath: string): Promise<boolean> => {
    try {
        const stats = await fs.stat(filePath);
        return stats.isDirectory();
    } catch {
        return false;
    }
};

const isFile = async (filePath: string): Promise<boolean> => {
    try {
        const stats = await fs.stat(filePath);
        return stats.isFile();
    } catch {
        return false;
    }
};

const readJson = async (filePath: string): Promise<unknown> => {
    const source = await fs.readFile(filePath, "utf-8");
    return JSON.parse(source) as unknown;
};

const compareVersions = (left: string, right: string): number =>
    left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
    });

const findLocalLogo = async (
    appPath: string,
): Promise<{
    fileName: (typeof LOGO_FILES)[number];
    filePath: string;
} | null> => {
    for (const fileName of LOGO_FILES) {
        const filePath = path.join(appPath, fileName);

        if (await isFile(filePath)) {
            return { fileName, filePath };
        }
    }

    return null;
};

const resolveLogo = async (
    appId: string,
    appPath: string,
    icon?: string,
): Promise<string | null> => {
    if (await findLocalLogo(appPath)) {
        return `/templates/${encodeURIComponent(appId)}/logo`;
    }

    if (icon && SAFE_SEGMENT.test(icon.replace(/\.svg$/iu, ""))) {
        return svglIconUrl(icon);
    }

    return null;
};

export async function readTemplateLogo(
    appId: string,
    root = defaultTemplatesRoot(),
): Promise<{ body: Uint8Array; contentType: string } | null> {
    assertSafeTemplateSegment(appId, "template");

    const logo = await findLocalLogo(path.join(root, appId));

    if (!logo) {
        return null;
    }

    if (logo.fileName === "logo.svg") {
        const svg = ensureSvgNamespace(await fs.readFile(logo.filePath, "utf-8"));
        return {
            body: new TextEncoder().encode(svg),
            contentType: LOGO_MEDIA_TYPES[logo.fileName],
        };
    }

    return {
        body: new Uint8Array(await fs.readFile(logo.filePath)),
        contentType: LOGO_MEDIA_TYPES[logo.fileName],
    };
}

export async function readTemplateIconValue(
    appId: string,
    icon?: string,
    root = defaultTemplatesRoot(),
): Promise<string | null> {
    const logo = await readTemplateLogo(appId, root);

    if (logo) {
        return `data:${logo.contentType};base64,${Buffer.from(logo.body).toString("base64")}`;
    }

    if (icon && SAFE_SEGMENT.test(icon.replace(/\.svg$/iu, ""))) {
        return svglIconUrl(icon);
    }

    return null;
}

const listVersionNames = async (appPath: string): Promise<string[]> => {
    const versionsPath = path.join(appPath, "versions");

    if (!(await isDirectory(versionsPath))) {
        return [];
    }

    const entries = await fs.readdir(versionsPath, { withFileTypes: true });

    return entries
        .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
        .map((entry) => entry.name)
        .toSorted(compareVersions)
        .toReversed();
};

const readComposeFile = async (versionPath: string): Promise<string> => {
    for (const fileName of COMPOSE_FILES) {
        const composePath = path.join(versionPath, fileName);

        if (await isFile(composePath)) {
            return await fs.readFile(composePath, "utf-8");
        }
    }

    throw new Error("Template version is missing a compose file");
};

const readEnvFile = async (versionPath: string): Promise<{ name: string; value: string }[]> => {
    const envPath = path.join(versionPath, ".env");

    if (!(await isFile(envPath))) {
        return [];
    }

    const parsed = parseEnvFile(await fs.readFile(envPath, "utf-8"));

    if (parsed.errors.length > 0) {
        throw new Error(parsed.errors[0] ?? "Invalid template .env file");
    }

    return parsed.variables;
};

export async function readTemplateManifest(appPath: string): Promise<TemplateManifest> {
    const parsed = v.safeParse(
        TemplateManifestSchema,
        await readJson(path.join(appPath, "manifest.json")),
    );

    if (!parsed.success) {
        throw new Error("Invalid template manifest");
    }

    return parsed.output;
}

export async function listTemplates(root = defaultTemplatesRoot()): Promise<ResourceTemplate[]> {
    if (!(await isDirectory(root))) {
        return [];
    }

    const entries = await fs.readdir(root, { withFileTypes: true });
    const templates: ResourceTemplate[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) {
            continue;
        }

        const appPath = path.join(root, entry.name);

        try {
            const manifest = await readTemplateManifest(appPath);
            const versions = await listVersionNames(appPath);

            if (versions.length === 0) {
                continue;
            }

            templates.push({
                appId: entry.name,
                description: manifest.description,
                logoSrc: await resolveLogo(entry.name, appPath, manifest.icon),
                name: manifest.name,
                tags: manifest.tags,
                type: manifest.type,
                versions: versions.map((version) => ({ version })),
            });
        } catch {
            continue;
        }
    }

    return templates.toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function readTemplateVersion(
    appId: string,
    version: string,
    root = defaultTemplatesRoot(),
): Promise<TemplateVersion> {
    assertSafeTemplateSegment(appId, "template");
    assertSafeTemplateSegment(version, "version");

    const appPath = path.join(root, appId);
    const versionPath = path.join(appPath, "versions", version);

    if (!(await isDirectory(versionPath))) {
        throw new Error("Template version not found");
    }

    const manifest = await readTemplateManifest(appPath);

    return {
        compose: await readComposeFile(versionPath),
        manifest,
        variables: await readEnvFile(versionPath),
        version,
    };
}
