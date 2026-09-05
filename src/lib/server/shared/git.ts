import fs from "node:fs/promises";

import { log as evlog } from "evlog";
// oxlint-disable func-style
// oxlint-disable-next-line import/no-named-as-default stupid rule
import simpleGit from "simple-git";
import type { SimpleGit } from "simple-git";

import {
    createGitAuthenticationEnvironment,
    gitUrlForAuthentication,
    redactGitUrl,
    removeGitUrlCredentials,
} from "#lib/server/shared/git-auth";
import type { GitAuthentication } from "#lib/server/shared/git-auth";

export { redactGitUrl } from "#lib/server/shared/git-auth";

interface GitRepositoryOptions {
    repoPath: string;
    repoUrl: string;
}

interface AuthenticatedGitRepositoryOptions extends GitRepositoryOptions {
    authentication: GitAuthentication;
}

/**
 * simple-git 3.36+ treats these names as config-injection / RCE channels.
 * Inherited host values are dropped so we only opt in for Stoat-owned
 * credential env, not the operator's EDITOR/PAGER/PREFIX.
 */
const BLOCKED_INHERITED_ENV = new Set([
    "EDITOR",
    "GIT_ASKPASS",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_EDITOR",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_PROXY_COMMAND",
    "GIT_SEQUENCE_EDITOR",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_TEMPLATE_DIR",
    "PAGER",
    "PREFIX",
    "SSH_ASKPASS",
]);

const isBlockedInheritedEnv = (name: string): boolean => {
    const normalized = name.toUpperCase();

    if (BLOCKED_INHERITED_ENV.has(normalized)) {
        return true;
    }

    return normalized.startsWith("GIT_CONFIG_KEY_") || normalized.startsWith("GIT_CONFIG_VALUE_");
};

const mergeGitChildEnvironment = (env: Record<string, string>): Record<string, string> => {
    const inherited: Record<string, string> = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined || isBlockedInheritedEnv(name)) {
            continue;
        }

        inherited[name] = value;
    }

    return { ...inherited, ...env };
};

const gitUnsafeOptions = (env: Record<string, string>) => ({
    ...(env.GIT_CONFIG_COUNT ? { allowUnsafeConfigEnvCount: true } : {}),
    ...(env.GIT_SSH || env.GIT_SSH_COMMAND ? { allowUnsafeSshCommand: true } : {}),
});

const createGitClient = (baseDir?: string, env?: Record<string, string>): SimpleGit => {
    const client = simpleGit({
        timeout: { block: 60_000 },
        ...(baseDir ? { baseDir } : {}),
        ...(env ? { unsafe: gitUnsafeOptions(env) } : {}),
    });

    if (env) {
        // `.env(object)` replaces the child environment entirely. Merge a
        // sanitized process.env so `git` still has PATH, without reintroducing
        // host EDITOR/PAGER that simple-git would also refuse.
        client.env(mergeGitChildEnvironment(env));
    }

    return client;
};

const getRepoWithEnvironment = async ({
    env,
    repoPath,
    repoUrl,
}: GitRepositoryOptions & {
    env?: Record<string, string>;
}): Promise<SimpleGit> => {
    const safeRepoUrl = redactGitUrl(repoUrl);
    const cloneClient = createGitClient(undefined, env);

    try {
        await fs.access(`${repoPath}/.git`);
        evlog.info({
            action: "git.repository_found",
            repoPath,
            repoUrl: safeRepoUrl,
        });
    } catch {
        evlog.info({
            action: "git.repository_clone_started",
            repoPath,
            repoUrl: safeRepoUrl,
        });
        await cloneClient.clone(repoUrl, repoPath);
        evlog.info({
            action: "git.repository_cloned",
            repoPath,
            repoUrl: safeRepoUrl,
        });
        return createGitClient(repoPath, env);
    }

    const repo = createGitClient(repoPath, env);
    await repo.remote(["set-url", "origin", repoUrl]);
    const head = await repo.raw(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.trim()) {
        await repo.pull(["--ff-only"]);
    } else {
        await repo.fetch();
        const branches = await repo.raw([
            "for-each-ref",
            "--format=%(refname)",
            "refs/remotes/origin",
        ]);
        if (branches.trim()) await repo.pull(["--ff-only"]);
    }
    evlog.info({
        action: "git.repository_pulled",
        repoPath,
        repoUrl: safeRepoUrl,
    });
    return repo;
};

/**
 * Clones or updates a repository without ever logging embedded URL secrets.
 * For authenticated work use withGitRepo so temporary SSH files are removed
 * once all clone, pull, and push operations have completed.
 */
export const getRepo = async ({ repoPath, repoUrl }: GitRepositoryOptions): Promise<SimpleGit> =>
    await getRepoWithEnvironment({
        repoPath,
        repoUrl: removeGitUrlCredentials(repoUrl),
    });

/**
 * Runs repository operations with scoped credentials. HTTPS credentials are
 * passed to Git through an environment-only extra header; SSH private keys
 * are temporary 0600 files and are removed in the finally block.
 */
export const withGitRepo = async <Result>(
    { authentication, repoPath, repoUrl }: AuthenticatedGitRepositoryOptions,
    operation: (repo: SimpleGit) => Promise<Result>,
): Promise<Result> => {
    const runtime = await createGitAuthenticationEnvironment(authentication);
    const authenticatedUrl = gitUrlForAuthentication(repoUrl, authentication);

    try {
        const repo = await getRepoWithEnvironment({
            env: runtime.env,
            repoPath,
            repoUrl: authenticatedUrl,
        });

        return await operation(repo);
    } finally {
        await runtime.cleanup();
    }
};
