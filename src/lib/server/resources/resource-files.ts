// oxlint-disable func-style
import { and, asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { resourceFiles, resources } from "#lib/db/schema";
import {
    assertSafeResourceFileContent,
    assertSafeResourceFilePath,
    normalizeResourceFilePath,
} from "#lib/domain/resources/files";
import {
    listComposeConfigReferences,
    normalizeConfigFilePath,
} from "#lib/server/deployments/deployment-compose";

export interface CreateResourceFileInput {
    path: string;
    content: string;
}

export interface UpdateResourceFileInput {
    path?: string;
    content?: string;
}

const isUniqueViolation = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505";

const toDuplicatePathError = (path: string): Error =>
    new Error(`A file named '${path}' already exists`);

export async function listResourceFiles(resourceId: string) {
    return await db
        .select()
        .from(resourceFiles)
        .where(eq(resourceFiles.resourceId, resourceId))
        .orderBy(asc(resourceFiles.path));
}

export async function getResourceFile(resourceId: string, fileIdOrPath: string) {
    const [byId] = await db
        .select()
        .from(resourceFiles)
        .where(and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.id, fileIdOrPath)));

    if (byId) {
        return byId;
    }

    const [byPath] = await db
        .select()
        .from(resourceFiles)
        .where(and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.path, fileIdOrPath)));

    return byPath;
}

export async function createResourceFile(resourceId: string, input: CreateResourceFileInput) {
    const path = assertSafeResourceFilePath(normalizeResourceFilePath(input.path));
    const content = assertSafeResourceFileContent(input.content);

    const [existing] = await db
        .select({ id: resourceFiles.id })
        .from(resourceFiles)
        .where(and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.path, path)));

    if (existing) {
        throw toDuplicatePathError(path);
    }

    try {
        const [created] = await db
            .insert(resourceFiles)
            .values({ content, path, resourceId })
            .returning();

        if (!created) {
            throw new Error("Unable to create resource file");
        }

        return created;
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw toDuplicatePathError(path);
        }

        throw error;
    }
}

export async function updateResourceFile(
    resourceId: string,
    fileId: string,
    patch: UpdateResourceFileInput,
) {
    const [existing] = await db
        .select()
        .from(resourceFiles)
        .where(and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.id, fileId)));

    if (!existing) {
        throw new Error("Resource file not found");
    }

    const next: { path?: string; content?: string } = {};

    if (patch.path !== undefined) {
        next.path = assertSafeResourceFilePath(normalizeResourceFilePath(patch.path));
    }

    if (patch.content !== undefined) {
        next.content = assertSafeResourceFileContent(patch.content);
    }

    if (next.path === undefined && next.content === undefined) {
        return existing;
    }

    if (next.path !== undefined && next.path !== existing.path) {
        const [conflict] = await db
            .select({ id: resourceFiles.id })
            .from(resourceFiles)
            .where(
                and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.path, next.path)),
            );

        if (conflict) {
            throw toDuplicatePathError(next.path);
        }
    }

    try {
        const [updated] = await db
            .update(resourceFiles)
            .set(next)
            .where(and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.id, fileId)))
            .returning();

        if (!updated) {
            throw new Error("Resource file not found");
        }

        return updated;
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw toDuplicatePathError(next.path ?? existing.path);
        }

        throw error;
    }
}

export async function deleteResourceFile(resourceId: string, fileId: string) {
    const [deleted] = await db
        .delete(resourceFiles)
        .where(and(eq(resourceFiles.resourceId, resourceId), eq(resourceFiles.id, fileId)))
        .returning();

    if (!deleted) {
        throw new Error("Resource file not found");
    }

    return deleted;
}

export async function deleteResourceFilesForResource(resourceId: string): Promise<void> {
    await db.delete(resourceFiles).where(eq(resourceFiles.resourceId, resourceId));
}

export async function replaceResourceFiles(
    resourceId: string,
    files: readonly CreateResourceFileInput[],
) {
    const normalized = files.map((file) => ({
        content: assertSafeResourceFileContent(file.content),
        path: assertSafeResourceFilePath(normalizeResourceFilePath(file.path)),
    }));
    const paths = normalized.map((file) => file.path);

    if (new Set(paths).size !== paths.length) {
        throw new Error("Resource file paths must be unique");
    }

    return await db.transaction(async (tx) => {
        await tx.delete(resourceFiles).where(eq(resourceFiles.resourceId, resourceId));

        if (normalized.length === 0) {
            return [];
        }

        return await tx
            .insert(resourceFiles)
            .values(normalized.map((file) => ({ ...file, resourceId })))
            .returning();
    });
}

export interface ResourceConfigReference {
    config: string;
    file: string | null;
}

/** Compose `configs:` references for UI hints. Never throws: invalid YAML yields []. */
export async function listResourceConfigReferences(
    resourceId: string,
): Promise<ResourceConfigReference[]> {
    const [resource] = await db
        .select({ value: resources.value })
        .from(resources)
        .where(eq(resources.id, resourceId));

    if (!resource?.value) return [];

    try {
        return listComposeConfigReferences(resource.value).map((reference) => ({
            config: reference.config,
            file: reference.file ? normalizeConfigFilePath(reference.file) : null,
        }));
    } catch {
        return [];
    }
}

// Files are the source of truth for resource configuration, so a copy
// brings them along to the new resource in the target workspace.
export async function copyResourceFiles(sourceResourceId: string, targetResourceId: string) {
    const source = await listResourceFiles(sourceResourceId);

    if (source.length === 0) {
        return [];
    }

    return await db
        .insert(resourceFiles)
        .values(
            source.map((file) => ({
                content: file.content,
                path: file.path,
                resourceId: targetResourceId,
            })),
        )
        .returning();
}
