import posix from "node:path/posix";

import * as v from "valibot";

export const MAX_RESOURCE_FILE_BYTES = 262_144;

export const MAX_RESOURCE_FILE_PATH_LENGTH = 128;

export const RESOURCE_FILE_PATH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u;

export interface ResourceFile {
    id: string;
    resourceId: string;
    path: string;
    content: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ResourceFileInput {
    path: string;
    content: string;
}

const textEncoder = new TextEncoder();

export function resourceFileByteLength(content: string): number {
    return textEncoder.encode(content).length;
}

export function normalizeResourceFilePath(value: string): string {
    const normalized = posix.normalize(value.trim());

    return normalized.replace(/^(?:\.\/)+/u, "");
}

export function assertSafeResourceFilePath(path: string): string {
    if (typeof path !== "string" || path.length === 0) {
        throw new Error("File path is required");
    }

    if (path !== path.trim()) {
        throw new Error(`File path "${path}" must not have leading or trailing whitespace`);
    }

    if (path.includes("\\")) {
        throw new Error(`File path "${path}" must not contain backslashes`);
    }

    if (path.startsWith("/")) {
        throw new Error(`File path "${path}" must be relative`);
    }

    if (path.length > MAX_RESOURCE_FILE_PATH_LENGTH) {
        throw new Error(
            `File path "${path}" is too long (max ${MAX_RESOURCE_FILE_PATH_LENGTH} characters)`,
        );
    }

    if (!RESOURCE_FILE_PATH_PATTERN.test(path)) {
        throw new Error(`File path "${path}" contains invalid characters`);
    }

    if (normalizeResourceFilePath(path) !== path) {
        throw new Error(`File path "${path}" is not normalized`);
    }

    const segments = path.split("/");

    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new Error(`File path "${path}" must not contain "${segment}" segments`);
        }

        if (segment === ".git") {
            throw new Error(`File path "${path}" must not contain ".git" segments`);
        }
    }

    return path;
}

export function assertSafeResourceFileContent(content: string): string {
    if (typeof content !== "string") {
        throw new TypeError("File content must be a string");
    }

    if (content.includes("\0")) {
        throw new Error("File looks binary (NUL byte found); only text files are supported");
    }

    if (resourceFileByteLength(content) > MAX_RESOURCE_FILE_BYTES) {
        throw new Error(`File is too large (max ${MAX_RESOURCE_FILE_BYTES} bytes)`);
    }

    return content;
}

const ResourceFilePathSchema = v.pipe(
    v.string(),
    v.minLength(1, "File path is required"),
    v.maxLength(MAX_RESOURCE_FILE_PATH_LENGTH, "File path is too long"),
    v.regex(RESOURCE_FILE_PATH_PATTERN, "File path contains invalid characters"),
    v.check((path) => !path.includes("\\"), "File path must not contain backslashes"),
    v.check((path) => !path.startsWith("/"), "File path must be relative"),
    v.check(
        (path) => !path.split("/").some((segment) => segment === ".."),
        'File path must not contain ".." segments',
    ),
    v.check(
        (path) => !path.split("/").some((segment) => segment === ".git"),
        'File path must not contain ".git" segments',
    ),
    v.check((path) => normalizeResourceFilePath(path) === path, "File path is not normalized"),
);

const ResourceFileContentSchema = v.pipe(
    v.string(),
    v.check(
        (content) => !content.includes("\0"),
        "File looks binary (NUL byte found); only text files are supported",
    ),
    v.check(
        (content) => resourceFileByteLength(content) <= MAX_RESOURCE_FILE_BYTES,
        `File is too large (max ${MAX_RESOURCE_FILE_BYTES} bytes)`,
    ),
);

export const ResourceFileInputSchema = v.object({
    content: ResourceFileContentSchema,
    path: ResourceFilePathSchema,
});

export const ResourceFileUpdateSchema = v.object({
    content: v.optional(ResourceFileContentSchema),
    path: v.optional(ResourceFilePathSchema),
});
