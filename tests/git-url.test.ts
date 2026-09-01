import { describe, expect, it } from "vite-plus/test";

import { redactGitUrl } from "#lib/server/shared/git";

describe("redactGitUrl", () => {
    it("redacts userinfo credentials from https URLs", () => {
        expect(redactGitUrl("https://user:secret@git.example.com/org/repo.git")).toBe(
            "https://***@git.example.com/org/repo.git",
        );
    });

    it("redacts token-only userinfo", () => {
        expect(redactGitUrl("https://ghp_token@github.com/org/repo.git")).toBe(
            "https://***@github.com/org/repo.git",
        );
    });

    it("leaves credential-free URLs unchanged", () => {
        expect(redactGitUrl("https://git.example.com/org/repo.git")).toBe(
            "https://git.example.com/org/repo.git",
        );
        expect(redactGitUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
    });

    it("redacts userinfo in non-parseable URLs via fallback", () => {
        expect(redactGitUrl("ssh://user:secret@host/repo.git")).toBe("ssh://***@host/repo.git");
    });
});
