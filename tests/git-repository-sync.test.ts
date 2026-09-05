import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { expect, it } from "vite-plus/test";

import {
    commitRepositoryFiles,
    headCommit,
    pendingCommits,
    readCommitComposeFiles,
    writeRepositoryFile,
} from "#lib/server/git-sources/repository";

it("enumerates every unseen commit in order and reads each immutable Compose version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-git-history-"));
    try {
        const repo = simpleGit(root);
        await repo.init();
        await repo.addConfig("user.name", "Test");
        await repo.addConfig("user.email", "test@localhost");
        const commits: string[] = [];
        for (const version of [1, 2, 3]) {
            await writeRepositoryFile(
                root,
                "prod/web/compose.yaml",
                `services:\n  web:\n    image: nginx:${version}\n`,
            );
            await repo.add(".");
            await repo.commit(`Version ${version}`);
            commits.push((await headCommit(repo)) ?? "");
        }
        expect(await pendingCommits(repo, commits[0] ?? null, commits[2] ?? null)).toEqual(
            commits.slice(1),
        );
        expect(await pendingCommits(repo, null, commits[2] ?? null)).toEqual(commits.slice(2));
        const cache = new Map<string, string>();
        const files = await readCommitComposeFiles(repo, commits[1] ?? "", cache);
        expect(files[0]?.compose).toContain("nginx:2");
        expect(await readFile(path.join(root, "prod/web/compose.yaml"), "utf8")).toContain(
            "nginx:3",
        );
        await repo.checkout(["--orphan", "rewritten"]);
        await repo.add(".");
        await repo.commit("New history");
        await expect(
            pendingCommits(repo, commits[0] ?? null, await headCommit(repo)),
        ).rejects.toThrow("history was rewritten");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it("refuses to write through a repository file or directory symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-git-path-"));
    try {
        await mkdir(path.join(root, "outside"));
        await writeFile(path.join(root, "outside", "secret"), "unchanged");
        await symlink(path.join(root, "outside"), path.join(root, "linked"));
        await symlink(path.join(root, "outside", "secret"), path.join(root, "compose.yaml"));
        await expect(writeRepositoryFile(root, "linked/secret", "overwrite")).rejects.toThrow(
            "symlink",
        );
        await expect(writeRepositoryFile(root, "compose.yaml", "overwrite")).rejects.toThrow(
            "symlink",
        );
        expect(await readFile(path.join(root, "outside", "secret"), "utf8")).toBe("unchanged");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it("stages literal repository paths without including neighboring files through Git wildcards", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-git-literal-"));
    try {
        const remote = path.join(root, "remote.git");
        const work = path.join(root, "work");
        await mkdir(remote);
        await simpleGit(remote).init(true, { "--initial-branch": "main" });
        await simpleGit().clone(remote, work);
        const repo = simpleGit(work);
        await writeRepositoryFile(
            work,
            "prod/*/compose.yaml",
            "services: { web: { image: nginx } }\n",
        );
        await writeRepositoryFile(work, "prod/private/compose.yaml", "private configuration\n");
        const commit = await commitRepositoryFiles(
            repo,
            ["prod/*/compose.yaml"],
            "Save selected configuration",
        );
        expect(commit).toBeTruthy();
        expect((await repo.raw(["ls-tree", "-r", "--name-only", "HEAD"])).trim()).toBe(
            "prod/*/compose.yaml",
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
