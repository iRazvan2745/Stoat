import { GitSyncError } from "#lib/server/git-sources/errors";
// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import type { SimpleGit } from "simple-git";

import { assertRepositoryPath } from "#lib/server/git-sources/compose";

const COMPOSE_NAMES = new Set([
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
]);
const IGNORED = new Set([".git", "node_modules", "dist", "coverage", ".svelte-kit", ".vite"]);

export const headCommit = async (repo: SimpleGit): Promise<string | null> => {
    const result = await repo.raw(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return result.trim() || null;
};

export const pendingCommits = async (
    repo: SimpleGit,
    previous: string | null,
    head: string | null,
): Promise<string[]> => {
    if (!head || previous === head) return [];
    if (!previous) return [head];
    try {
        const ancestor = (await repo.raw(["merge-base", previous, head])).trim();
        if (ancestor !== previous) throw new GitSyncError("Unrelated history");
    } catch {
        throw new GitSyncError(
            "Git history was rewritten or the repository changed. Restore the tracked history before syncing.",
        );
    }
    const revisions = await repo.raw([
        "rev-list",
        "--reverse",
        "--first-parent",
        `${previous}..${head}`,
    ]);
    return revisions.trim().split("\n").filter(Boolean);
};

export interface RepositoryComposeFile {
    path: string;
    compose: string;
}

/** Read immutable Git blobs rather than changing the working tree for each deployment. */
export const readCommitComposeFiles = async (
    repo: SimpleGit,
    commit: string,
    cache: Map<string, string>,
): Promise<RepositoryComposeFile[]> => {
    const tree = await repo.raw(["ls-tree", "-r", "-z", commit]);
    const files: RepositoryComposeFile[] = [];
    for (const entry of tree.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type, hash] = entry.slice(0, tab).split(" ");
        const relativePath = entry.slice(tab + 1);
        if (
            type !== "blob" ||
            !mode?.startsWith("100") ||
            !hash ||
            !COMPOSE_NAMES.has(path.posix.basename(relativePath))
        )
            continue;
        if (relativePath.split("/").some((part) => IGNORED.has(part))) continue;
        assertRepositoryPath(relativePath);
        let compose = cache.get(hash);
        if (compose === undefined) {
            const size = Number(await repo.raw(["cat-file", "-s", hash]));
            if (size > 1_048_576)
                throw new GitSyncError(`Compose file exceeds 1 MiB: ${relativePath}`);
            compose = await repo.raw(["cat-file", "blob", hash]);
            if (cache.size >= 1000) cache.clear();
            cache.set(hash, compose);
        }
        files.push({ compose, path: relativePath });
    }
    return files;
};

/** Reject symlinks at every path component, including files already in a repository. */
export const validateRepositoryFilePath = async (
    root: string,
    relativePath: string,
): Promise<string> => {
    assertRepositoryPath(relativePath);
    const parts = relativePath.split("/");
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink())
                throw new GitSyncError(
                    `Refusing to write through a repository symlink: ${relativePath}`,
                );
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
        }
    }
    return current;
};

export const writeRepositoryFile = async (
    root: string,
    relativePath: string,
    contents: string,
): Promise<void> => {
    const current = await validateRepositoryFilePath(root, relativePath);
    await fs.mkdir(path.dirname(current), { recursive: true });
    await fs.writeFile(current, contents, "utf8");
};

export const commitRepositoryFiles = async (
    repo: SimpleGit,
    files: string[],
    message: string,
): Promise<string | null> => {
    if (files.length === 0) return await headCommit(repo);
    await repo.raw(["--literal-pathspecs", "add", "--", ...files]);
    const changes = await repo.diff(["--cached", "--name-only"]);
    if (changes.trim()) {
        await repo.raw([
            "-c",
            "user.name=Stoat",
            "-c",
            "user.email=stoat@localhost",
            "commit",
            "-m",
            message,
        ]);
    }
    await repo.push(["--set-upstream", "origin", "HEAD"]);
    return await headCommit(repo);
};
