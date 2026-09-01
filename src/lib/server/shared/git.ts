import fs from "node:fs/promises";

import { log as evlog } from "evlog";
// oxlint-disable func-style
// oxlint-disable-next-line import/no-named-as-default stupid rule
import simpleGit from "simple-git";

const USERINFO_PATTERN = /\/\/[^@/]+@/u;

/** Strips embedded credentials (user:password@) from a git URL for safe logging. */
export function redactGitUrl(url: string): string {
    try {
        const parsed = new URL(url);

        if (parsed.username || parsed.password) {
            parsed.username = "***";
            parsed.password = "";
        }

        return parsed.toString();
    } catch {
        return url.replace(USERINFO_PATTERN, "//***@");
    }
}

export async function getRepo({ repoPath, repoUrl }: { repoPath: string; repoUrl: string }) {
    try {
        await fs.access(`${repoPath}/.git`);
        evlog.info({
            action: "git.repository_found",
            repoPath,
            repoUrl: redactGitUrl(repoUrl),
        });
    } catch {
        evlog.info({
            action: "git.repository_clone_started",
            repoPath,
            repoUrl: redactGitUrl(repoUrl),
        });
        await simpleGit().clone(repoUrl, repoPath);
        evlog.info({
            action: "git.repository_cloned",
            repoPath,
            repoUrl: redactGitUrl(repoUrl),
        });
        return simpleGit(repoPath);
    }

    const repo = simpleGit(repoPath);
    await repo.pull();
    evlog.info({
        action: "git.repository_pulled",
        repoPath,
        repoUrl: redactGitUrl(repoUrl),
    });
    return repo;
}
