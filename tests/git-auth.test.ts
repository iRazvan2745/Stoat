import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { describe, expect, it } from "vite-plus/test";

import { withGitRepo } from "#lib/server/shared/git";
import {
    createGitAuthenticationEnvironment,
    decryptGitAuthentication,
    encryptGitAuthentication,
    gitAuthenticationFromSource,
    gitUrlForAuthentication,
    redactGitAuthentication,
    removeGitUrlCredentials,
    validateGitAuthentication,
    validateGitSource,
    validateGitUrl,
} from "#lib/server/shared/git-auth";

const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
not-a-real-key-for-unit-tests
-----END OPENSSH PRIVATE KEY-----`;

const withLocalGitRepo = async <Result>(
    authentication: Parameters<typeof withGitRepo>[0]["authentication"],
    operation: (repo: SimpleGit) => Promise<Result>,
): Promise<Result> => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-git-auth-"));
    const remote = path.join(root, "remote.git");
    const local = path.join(root, "local");

    try {
        await mkdir(local);
        await simpleGit().raw(["init", "--bare", remote]);
        await simpleGit().raw(["init", "-b", "main", local]);

        const setup = simpleGit(local);
        await setup.addConfig("user.email", "stoat@example.com");
        await setup.addConfig("user.name", "Stoat");
        await writeFile(path.join(local, "README"), "ok\n");
        await setup.add("README");
        await setup.commit("init");
        await setup.addRemote("origin", remote);
        await setup.push(["-u", "origin", "main"]);

        return await withGitRepo(
            {
                authentication,
                repoPath: local,
                repoUrl: remote,
            },
            operation,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
};

describe("Git authentication validation", () => {
    it("accepts token, basic, SSH, and public source modes", () => {
        expect(validateGitAuthentication()).toEqual({
            method: "none",
        });
        expect(
            validateGitAuthentication({
                method: "token",
                token: "ghp_secret",
                username: "x",
            }),
        ).toEqual({ method: "token", token: "ghp_secret", username: "x" });
        expect(
            validateGitAuthentication({
                method: "basic",
                password: "secret",
                username: "deploy",
            }),
        ).toEqual({ method: "basic", password: "secret", username: "deploy" });
        expect(
            validateGitAuthentication({
                knownHosts: "git.example ssh-ed25519 AAAA...",
                method: "ssh",
                privateKey,
                username: "git",
            }),
        ).toEqual({
            knownHosts: "git.example ssh-ed25519 AAAA...",
            method: "ssh",
            privateKey,
            username: "git",
        });
    });

    it("rejects incomplete or mismatched credential modes", () => {
        expect(() => validateGitAuthentication({ method: "token" })).toThrow("requires a token");
        expect(() => validateGitAuthentication({ method: "basic", password: "secret" })).toThrow(
            "username and password",
        );
        expect(() =>
            validateGitAuthentication({
                method: "ssh",
                privateKey: "not-a-key",
            }),
        ).toThrow("private key");
        expect(() => validateGitAuthentication({ method: "https", token: "secret" })).toThrow(
            "specify token or basic mode",
        );
    });
});

describe("Git URL handling", () => {
    it("removes embedded credentials and sensitive query values", () => {
        expect(
            removeGitUrlCredentials(
                "https://deploy:secret@git.example.com/team/repo.git?token=leak&ref=main#fragment",
            ),
        ).toBe("https://git.example.com/team/repo.git?ref=main");
        expect(removeGitUrlCredentials("git@git.example.com:team/repo.git")).toBe(
            "git@git.example.com:team/repo.git",
        );
        expect(removeGitUrlCredentials("deploy:secret@git.example.com:team/repo.git")).toBe(
            "git.example.com:team/repo.git",
        );
    });

    it("validates HTTPS, SSH, git, and SCP repository URLs", () => {
        expect(validateGitUrl("https://git.example.com/team/repo.git").protocol).toBe("https");
        expect(validateGitUrl("ssh://git.example.com/team/repo.git").protocol).toBe("ssh");
        expect(validateGitUrl("git@git.example.com:team/repo.git").protocol).toBe("scp");
        expect(() => validateGitUrl("file:///tmp/repo")).toThrow("HTTPS, SSH, git, or SCP");
        expect(() => validateGitUrl("https://git.example.com")).toThrow("repository path");
    });

    it("adds a non-secret SSH username without adding URL credentials", () => {
        expect(
            gitUrlForAuthentication("ssh://git.example.com/team/repo.git", {
                method: "ssh",
                privateKey,
                username: "deploy",
            }),
        ).toBe("ssh://deploy@git.example.com/team/repo.git");
        expect(
            gitUrlForAuthentication("https://user:secret@git.example.com/repo.git", {
                method: "token",
                token: "secret",
            }),
        ).toBe("https://git.example.com/repo.git");
    });

    it("requires transport-compatible authentication", () => {
        expect(
            validateGitSource({
                authentication: { method: "token", token: "secret" },
                url: "https://git.example.com/team/repo.git",
            }).url,
        ).toBe("https://git.example.com/team/repo.git");
        expect(() =>
            validateGitSource({
                authentication: { method: "token", token: "secret" },
                url: "ssh://git.example.com/team/repo.git",
            }),
        ).toThrow("require an HTTPS URL");
        expect(() =>
            validateGitSource({
                authentication: { method: "none" },
                url: "https://user:secret@git.example.com/team/repo.git",
            }),
        ).toThrow("choose an authentication method");
        expect(
            validateGitSource({
                authentication: { method: "none" },
                url: "git@git.example.com:team/repo.git",
            }).url,
        ).toBe("git@git.example.com:team/repo.git");
    });

    it("maps a server-only Git Source connection to runtime credentials", () => {
        expect(
            gitAuthenticationFromSource({
                authMethod: "basic",
                password: "secret",
                username: "deploy",
            }),
        ).toEqual({ method: "basic", password: "secret", username: "deploy" });
    });
});

describe("Git authentication runtime", () => {
    it("passes HTTPS secrets through an encoded child-process header", async () => {
        const runtime = await createGitAuthenticationEnvironment({
            method: "token",
            token: "ghp_secret",
            username: "x-access-token",
        });

        try {
            expect(runtime.env.GIT_CONFIG_VALUE_0).toBe(
                "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==",
            );
            expect(runtime.env.GIT_CONFIG_VALUE_0).not.toContain("ghp_secret");
            expect(runtime.env.GIT_TERMINAL_PROMPT).toBe("0");
        } finally {
            await runtime.cleanup();
        }
    });

    it("creates and cleans up a temporary SSH key file", async () => {
        const runtime = await createGitAuthenticationEnvironment({
            method: "ssh",
            privateKey,
        });

        try {
            expect(runtime.env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
            expect(runtime.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
            expect(runtime.env.GIT_SSH_COMMAND).not.toContain("not-a-real-key");
        } finally {
            await runtime.cleanup();
        }
    });

    it("runs token-authenticated git commands despite simple-git's config-env block", async () => {
        const previousEditor = process.env.EDITOR;
        process.env.EDITOR = "vim";

        try {
            await expect(
                withLocalGitRepo(
                    { method: "token", token: "test-token" },
                    async (repo) => await repo.status(),
                ),
            ).resolves.toMatchObject({ current: "main" });
        } finally {
            if (previousEditor === undefined) {
                delete process.env.EDITOR;
            } else {
                process.env.EDITOR = previousEditor;
            }
        }
    });

    it("runs SSH-authenticated git commands despite simple-git's GIT_SSH_COMMAND block", async () => {
        await expect(
            withLocalGitRepo({ method: "ssh", privateKey }, async (repo) => await repo.status()),
        ).resolves.toMatchObject({ current: "main" });
    });

    it("returns only safe credential metadata", () => {
        expect(
            redactGitAuthentication({
                method: "basic",
                password: "secret",
                username: "deploy",
            }),
        ).toEqual({
            hasCredentials: true,
            method: "basic",
            username: "deploy",
        });
    });
});

describe("Git authentication encryption", () => {
    it("round-trips credentials without storing plaintext", async () => {
        const authentication = {
            method: "token" as const,
            token: "ghp_secret",
        };
        const encrypted = await encryptGitAuthentication(authentication, "app-secret");

        expect(encrypted).toMatch(/^v1\.[^.]+\.[^.]+$/u);
        expect(encrypted).not.toContain("ghp_secret");
        await expect(decryptGitAuthentication(encrypted, "app-secret")).resolves.toEqual(
            authentication,
        );
        await expect(decryptGitAuthentication(encrypted, "wrong-secret")).rejects.toThrow(
            "Unable to decrypt Git credentials",
        );
    });
});
