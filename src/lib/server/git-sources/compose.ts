import { GitComposeError, GitSyncError } from "#lib/server/git-sources/errors";
import { createHash } from "node:crypto";
import path from "node:path";

import * as v from "valibot";
import YAML, { isNode } from "yaml";

import type { GitResourceSyncState } from "#lib/domain/git-sync";
import type { ResourceSettings } from "#lib/domain/resources/settings";
import { formatComposeFile, unformatComposeFile } from "#lib/server/deployments/deployment-compose";

const Name = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const Slug = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/u));
const MetadataInput = v.object({
    version: v.literal(1),
    workspaceId: Name,
    dataSourceId: Name,
    name: v.nullable(Name),
    slug: Slug,
    workspaceName: v.nullable(Name),
    workspaceSlug: Slug,
    groupName: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(80))),
    icon: v.nullable(v.string()),
    shouldPrefix: v.boolean(),
    resourceId: Name,
});
export type GitComposeMetadata = v.InferOutput<typeof MetadataInput>;

export interface GitComposeResource {
    id: string;
    name: string | null;
    slug: string | null;
    groupName?: string | null;
    icon: string | null;
    value: string | null;
    settings: ResourceSettings;
}

export interface GitComposeWorkspace {
    id: string;
    name: string | null;
    slug: string;
    dataSourceId: string;
}

export const composeFingerprint = (value: string): string =>
    createHash("sha256").update(YAML.parseDocument(value).toString()).digest("hex");

export const metadataFor = (
    resource: GitComposeResource,
    workspace: GitComposeWorkspace,
): GitComposeMetadata => ({
    version: 1,
    resourceId: resource.id,
    workspaceId: workspace.id,
    dataSourceId: workspace.dataSourceId,
    name: resource.name,
    slug: resource.slug ?? resource.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    groupName: resource.groupName ?? null,
    icon: resource.icon,
    shouldPrefix: resource.settings.shouldPrefix !== false,
});

/** Git stores deployment names and non-secret app metadata; values remain uninlined. */
export const exportGitCompose = (
    resource: GitComposeResource,
    workspace: GitComposeWorkspace,
): string => {
    const metadata = metadataFor(resource, workspace);
    const formatted = formatComposeFile(
        resource.value ?? "",
        metadata.shouldPrefix ? metadata.slug : undefined,
    );
    if (formatted.serviceCount === 0)
        throw new GitSyncError("Compose must contain at least one service");
    const document = YAML.parseDocument(formatted.yaml);
    document.set("x-stoat", metadata);
    return document.toString();
};

export const readGitCompose = (
    compose: string,
    fallbackPrefix?: string,
): {
    raw: string;
    formatted: string;
    metadata: GitComposeMetadata | null;
} => {
    const document = YAML.parseDocument(compose);
    if (document.errors.length > 0) throw new GitComposeError("Invalid Compose YAML");
    const node = document.get("x-stoat", true);
    const extension: unknown = isNode(node) ? node.toJSON() : node;
    const parsed = extension === undefined ? null : v.safeParse(MetadataInput, extension);
    if (parsed && !parsed.success) throw new GitComposeError("Invalid x-stoat metadata");
    const metadata: GitComposeMetadata | null = parsed?.output ?? null;
    document.delete("x-stoat");
    const formatted = document.toString();
    const prefix = metadata ? (metadata.shouldPrefix ? metadata.slug : undefined) : fallbackPrefix;
    try {
        if (formatComposeFile(formatted).serviceCount === 0)
            throw new Error("Compose must contain at least one service");
        return { formatted, metadata, raw: unformatComposeFile(formatted, prefix) };
    } catch (error) {
        throw new GitComposeError(
            error instanceof Error ? error.message : "Invalid Compose configuration",
        );
    }
};

export const canonicalComposePath = (
    resource: GitComposeResource,
    workspace: GitComposeWorkspace,
): string => {
    // Percent encoding keeps group labels reversible and prevents path traversal.
    const folders = [workspace.slug];
    if (resource.groupName)
        folders.push(encodeURIComponent(resource.groupName).replaceAll(".", "%2E"));
    folders.push(resource.slug ?? resource.id, "compose.yaml");
    return folders.join("/");
};

export const assertRepositoryPath = (relativePath: string): void => {
    if (
        path.posix.isAbsolute(relativePath) ||
        relativePath.includes("\\") ||
        relativePath
            .split("/")
            .some((part) => !part || part === "." || part === ".." || part === ".git")
    ) {
        throw new GitSyncError("Invalid repository path");
    }
};

export const inferComposeLocation = (
    relativePath: string,
    repository: string,
): { workspaceName: string; resourceName: string; groupName: string | null } => {
    assertRepositoryPath(relativePath);
    const folders = relativePath.split("/").slice(0, -1);
    let groupName: string | null = null;
    if (folders.length > 2) {
        try {
            groupName = decodeURIComponent(folders.slice(1, -1).join("/"));
        } catch {
            groupName = folders.slice(1, -1).join("/");
        }
    }
    return {
        workspaceName: folders.length >= 2 ? (folders[0] ?? repository) : repository,
        resourceName: folders.at(-1) ?? repository,
        groupName,
    };
};

export type SyncDirection = "unchanged" | "pull" | "push" | "conflict";

export const syncDirection = (
    appHash: string,
    repoHash: string,
    base: GitResourceSyncState | null,
): SyncDirection => {
    if (appHash === repoHash) return "unchanged";
    if (!base) return "conflict";
    const appChanged = appHash !== base.appHash;
    const repoChanged = repoHash !== base.repoHash;
    if (appChanged && repoChanged) return "conflict";
    if (repoChanged) return "pull";
    return appChanged ? "push" : "unchanged";
};
