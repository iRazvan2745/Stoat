import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const network = vi.hoisted(() => ({
    fixture: "",
    addresses: [{ address: "93.184.216.34", family: 4 }],
    // SAFETY: the empty log is populated only with the command records below.
    calls: [] as {
        args: string[];
        env: NodeJS.ProcessEnv;
        config: string;
        sshConfig?: string;
        modes: number[];
    }[],
    // SAFETY: tests optionally install a command callback before invoking the transport.
    beforeCommand: undefined as ((args: string[]) => void) | undefined,
    failTransport: false,
    transportBehavior: "",
    // SAFETY: tests optionally supply raw ls-remote output bytes.
    headOutput: undefined as Buffer | undefined,
    version: "",
}));

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => network.addresses) }));

vi.mock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

    return {
        ...actual,
        spawn: vi.fn(
            (file: string, args: string[], options: import("node:child_process").SpawnOptions) => {
                const env = options.env!;
                const directory = String(options.cwd);
                const config = readFileSync(join(directory, "transport.config"), "utf8");
                const sshPath = join(directory, "ssh_config");
                const sshConfig = existsSync(sshPath) ? readFileSync(sshPath, "utf8") : undefined;

                const modes = [
                    "transport.config",
                    ...(sshConfig ? ["identity", "known_hosts", "ssh_config"] : []),
                ].map((name) => statSync(join(directory, name)).mode & 0o777);

                network.calls.push({ args: [...args], env: { ...env }, config, sshConfig, modes });
                network.beforeCommand?.(args);
                expect(options.shell).toBe(false);
                expect(options.detached).toBe(true);

                if (network.version && args.includes("--version")) {
                    return actual.spawn(
                        process.execPath,
                        ["-e", "process.stdout.write(process.env.VERSION)"],
                        { ...options, env: { VERSION: network.version } },
                    );
                }

                const remote = args.includes("fetch") || args.includes("ls-remote");

                if (network.failTransport && remote) {
                    return actual.spawn(
                        process.execPath,
                        [
                            "-e",
                            'process.stdout.write("secret-token"); process.stderr.write("secret-token PRIVATE KEY https://secret@host"); process.exit(1)',
                        ],
                        options,
                    );
                }

                if (network.transportBehavior && remote) {
                    const scripts = new Map([
                        ["hang", "setInterval(() => {}, 1000)"],
                        [
                            "stdout",
                            'process.stdout.write("a".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000)',
                        ],
                        [
                            "stderr",
                            'process.stderr.write("secret".repeat(256 * 1024)); setInterval(() => {}, 1000)',
                        ],
                        [
                            "disk",
                            'const fs = require("node:fs"); fs.ftruncateSync(fs.openSync("huge.pack", "w"), 129 * 1024 * 1024);',
                        ],
                    ]);

                    return actual.spawn(
                        process.execPath,
                        ["-e", scripts.get(network.transportBehavior)!],
                        options,
                    );
                }

                if (network.headOutput !== undefined && args.includes("ls-remote")) {
                    return actual.spawn(
                        process.execPath,
                        [
                            "-e",
                            'process.stdout.write(Buffer.from(process.env.HEAD_OUTPUT, "base64"))',
                        ],
                        {
                            ...options,
                            env: { ...env, HEAD_OUTPUT: network.headOutput.toString("base64") },
                        },
                    );
                }

                // Only the test transport is replaced. All init/tree/blob/index/commit operations
                // and the leased fetch/push are real Git against an isolated bare fixture.
                const transport = args.findIndex(
                    (arg) =>
                        arg.startsWith("https://") ||
                        arg.startsWith("ssh://") ||
                        /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):[^/]/u.test(arg),
                );

                if (transport !== -1) {
                    if (!network.fixture) throw new Error("Unexpected network operation in test");
                    args = [...args];
                    args[transport] = network.fixture;
                    args.unshift("-c", "protocol.file.allow=always");

                    return actual.spawn(file, args, {
                        ...options,
                        env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
                    });
                }

                return actual.spawn(file, args, options);
            },
        ),
    };
});

import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";

import {
    inspectGitRemote,
    listGitFiles,
    readGitFile,
    pushGitFile,
    validateGitUrl,
    validateGitPath,
    validateGitBranch,
} from "../../packages/api/src/git";
import type { GitRepository } from "../../packages/api/src/git";
import { decryptGitCredentials, encryptGitCredentials } from "../../packages/api/src/git-secrets";

beforeEach(() => {
    vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "");
    network.addresses = [{ address: "93.184.216.34", family: 4 }];
    network.calls = [];
    network.beforeCommand = undefined;
    network.failTransport = false;
    network.transportBehavior = "";
    network.headOutput = undefined;
    network.version = "";
    vi.mocked(lookup).mockClear();
    vi.mocked(spawn).mockClear();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("Git validation", () => {
    it("exports only the requested runtime adapter and encryption functions", async () => {
        expect(Object.keys(await import("../../packages/api/src/git")).sort()).toEqual([
            "inspectGitRemote",
            "listGitFiles",
            "pushGitFile",
            "readGitFile",
            "validateGitBranch",
            "validateGitPath",
            "validateGitUrl",
        ]);
        expect(Object.keys(await import("../../packages/api/src/git-secrets")).sort()).toEqual([
            "decryptGitCredentials",
            "encryptGitCredentials",
        ]);
    });

    it("normalizes arbitrary HTTPS and SSH hosts without a provider allowlist", () => {
        expect(validateGitUrl("https://GIT.Example.COM:443/team/repo.git/")).toBe(
            "https://git.example.com/team/repo.git",
        );
        expect(validateGitUrl("git@git.example.com:team/repo.git")).toBe(
            "ssh://git@git.example.com/~/team/repo.git",
        );
        expect(validateGitUrl("ssh://deploy@git.example.com:2222/team/repo.git")).toBe(
            "ssh://deploy@git.example.com:2222/team/repo.git",
        );
        expect(validateGitUrl("https://[2606:4700:4700::1111]/repo")).toContain(
            "2606:4700:4700::1111",
        );
    });

    it.each([
        ["git@github.com:team/repo.git", "ssh://git@github.com/~/team/repo.git"],
        ["git@git.example.com:/srv/repo.git", "ssh://git@git.example.com/srv/repo.git"],
        ["git@git.example.com:~/team/repo.git", "ssh://git@git.example.com/~/team/repo.git"],
        [
            "git@git.example.com:~other/team/repo.git",
            "ssh://git@git.example.com/~other/team/repo.git",
        ],
        ["ssh://git@git.example.com/srv/repo.git", "ssh://git@git.example.com/srv/repo.git"],
    ])("preserves SCP versus absolute SSH path semantics for %s", (url, normalized) => {
        expect(validateGitUrl(url)).toBe(normalized);
        expect(validateGitUrl(normalized)).toBe(normalized);
    });

    it.each([
        "file:///tmp/repo",
        "/tmp/repo",
        "../repo",
        "ext::sh -c attack",
        "git://git.example.com/repo",
        "http://git.example.com/repo",
        "https://user:token@git.example.com/repo",
        "https://user@git.example.com/repo",
        "ssh://git:token@git.example.com/repo",
        "https://git.example.com/repo?token=secret",
        "https://git.example.com/repo#fragment",
        "https://git.example.com/repo\n",
        "https://git.example.com/repo%0aheader",
        "ssh://-option@git.example.com/repo",
        "ssh://git@git.example.com/repo%27;id",
        "https://git.example.com/",
        "https://git.example.com:0/repo",
    ])("rejects unsafe URL %s", (url) => {
        expect(() => validateGitUrl(url)).toThrow();
    });

    it.each([
        "127.0.0.1",
        "127.1",
        "2130706433",
        "0x7f000001",
        "localhost",
        "a.localhost",
        "169.254.169.254",
        "100.100.100.200",
        "168.63.129.16",
        "0.0.0.0",
        "224.0.0.1",
        "[::1]",
        "[::]",
        "[::ffff:127.0.0.1]",
        "[fe80::1]",
        "[fd00:ec2::254]",
        "[fd20:ce::254]",
        "[64:ff9b::7f00:1]",
        "[2002:7f00:1::]",
        "metadata.google.internal",
    ])("never allows restricted address %s, even explicitly allowlisted", (host) => {
        vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", host);
        expect(() => validateGitUrl(`https://${host}/repo`)).toThrow();
    });

    it("allows only exact RFC1918/ULA hosts from the comma list", () => {
        expect(() => validateGitUrl("https://10.2.3.4/repo")).toThrow();
        vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", " 10.2.3.4, [fd12::1], GIT.INTERNAL. ");
        expect(validateGitUrl("https://10.2.3.4/repo")).toBe("https://10.2.3.4/repo");
        expect(validateGitUrl("https://[fd12::1]/repo")).toBe("https://[fd12::1]/repo");
        expect(() => validateGitUrl("https://10.2.3.5/repo")).toThrow();
        vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "10.0.0.0/8,*");
        expect(() => validateGitUrl("https://10.2.3.4/repo")).toThrow();
    });

    it.each([
        "",
        "/etc/passwd",
        "../file",
        "a/../b",
        "a/./b",
        "a//b",
        "a/",
        ".git/config",
        "a/.GIT/config",
        "C:/file",
        "a\\b",
        "a\0b",
        "a\nb",
        "a.",
        "a ",
        "\ud800",
    ])("rejects unsafe file path %s", (path) => {
        expect(() => validateGitPath(path)).toThrow();
    });

    it("accepts literal file names without shell or pathspec interpretation", () => {
        expect(validateGitPath("dir/--file [one] $(id).yaml")).toBe("dir/--file [one] $(id).yaml");
        expect(validateGitPath(".github/workflows/build.yml")).toBe(".github/workflows/build.yml");
    });

    it.each([
        "",
        "HEAD",
        "refs/heads/main",
        "-main",
        "@",
        "main~1",
        "main^",
        "main:foo",
        "main..foo",
        "main@{1}",
        "a.lock",
        ".main",
        "a/.b",
        "a//b",
        "a/",
        "a?",
        "a*",
        "a[",
        "a\\b",
        "a\nb",
        "a b",
    ])("rejects unsafe branch %s", (branch) => {
        expect(() => validateGitBranch(branch)).toThrow();
    });

    it("accepts named branches and slash-separated branches", () => {
        expect(validateGitBranch("main")).toBe("main");
        expect(validateGitBranch("feature/update-compose")).toBe("feature/update-compose");
    });
});

describe("Git credential envelopes", () => {
    const scope = { organizationId: "org-1", connectionId: "connection-1" };
    beforeEach(() => {
        vi.stubEnv("BETTER_AUTH_SECRET", "a-strong-test-secret-with-at-least-32-bytes");
    });

    it("round-trips token/basic, SSH and empty credentials with randomized envelopes", () => {
        for (const credentials of [
            {},
            { password: "secret-token" },
            { username: "user", password: "pw" },
            { privateKey: "PRIVATE KEY\nsecret", knownHosts: "host ssh-ed25519 AAAA" },
        ]) {
            const first = encryptGitCredentials(credentials, scope);
            expect(first).not.toContain("secret");
            expect(first).not.toEqual(encryptGitCredentials(credentials, scope));
            expect(decryptGitCredentials(first, scope)).toEqual(credentials);
        }
    });

    it("binds ciphertext to both organization and connection, without delimiter ambiguity", () => {
        const envelope = encryptGitCredentials({ password: "secret" }, scope);
        expect(() =>
            decryptGitCredentials(envelope, { ...scope, organizationId: "org-2" }),
        ).toThrow("Unable to decrypt");
        expect(() =>
            decryptGitCredentials(envelope, { ...scope, connectionId: "connection-2" }),
        ).toThrow("Unable to decrypt");
        const tricky = encryptGitCredentials({}, { organizationId: "a:b", connectionId: "c" });
        expect(() =>
            decryptGitCredentials(tricky, { organizationId: "a", connectionId: "b:c" }),
        ).toThrow();
    });

    it("rejects tampering of every envelope field and malformed encodings", () => {
        const envelope = encryptGitCredentials({ password: "secret" }, scope);

        for (let index = 0; index < 5; index++) {
            const parts = envelope.split(".");
            const part = parts[index]!;
            parts[index] = `${part[0] === "A" ? "B" : "A"}${part.slice(1)}`;
            expect(() => decryptGitCredentials(parts.join("."), scope)).toThrow(
                "Unable to decrypt",
            );
        }

        for (const value of ["", "plaintext", `${envelope}.extra`, `${envelope}=`, "v1.a.b.c.d"])
            expect(() => decryptGitCredentials(value, scope)).toThrow();
    });

    it("reads the secret internally on each call and fails closed on missing/short secrets", () => {
        const envelope = encryptGitCredentials({}, scope);
        vi.stubEnv("BETTER_AUTH_SECRET", "another-secret-that-is-at-least-32-bytes");
        expect(() => decryptGitCredentials(envelope, scope)).toThrow();

        for (const secret of ["", "short"]) {
            vi.stubEnv("BETTER_AUTH_SECRET", secret);
            expect(() => encryptGitCredentials({}, scope)).toThrow("BETTER_AUTH_SECRET");
            expect(() => decryptGitCredentials(envelope, scope)).toThrow("Unable to decrypt");
        }
    });

    it("validates scope and credential data without reflecting secrets", () => {
        expect(() => encryptGitCredentials({}, { organizationId: "", connectionId: "c" })).toThrow(
            "Invalid Git credential scope",
        );
        // SAFETY: deliberately malformed input exercises runtime credential validation.
        expect(() => encryptGitCredentials({ password: 123 } as never, scope)).toThrow(
            "Invalid Git credentials",
        );
        // SAFETY: deliberately unknown credential keys must be rejected at runtime.
        expect(() => encryptGitCredentials({ token: "secret" } as never, scope)).toThrow(
            "Invalid Git credentials",
        );
        expect(() =>
            encryptGitCredentials({ privateKey: "a".repeat(128 * 1024 + 1) }, scope),
        ).toThrow();
    });
});

describe("Git plumbing and transport isolation", () => {
    let directory: string;
    let initial: string;

    const repo: GitRepository = {
        url: "https://git.example.com/team/repo.git",
        branch: "main",
        credentials: {},
    };

    const author = { name: "Test Author", email: "test@example.com" };

    const fixtureGit = (args: string[], input?: string | Buffer): string =>
        execFileSync("git", ["--git-dir", network.fixture, ...args], {
            input,
            encoding: "utf8",
            env: {
                PATH: process.env.PATH,
                HOME: directory,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: author.name,
                GIT_COMMITTER_EMAIL: author.email,
            },
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();

    const commitFixture = (parent?: string): string => {
        const tree = fixtureGit(["write-tree"]);

        const revision = fixtureGit(
            ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
            "Fixture commit\n",
        );

        fixtureGit(["update-ref", "refs/heads/main", revision]);

        return revision;
    };

    const addFixture = (path: string, content: string | Buffer, mode = "100644") => {
        const blob = fixtureGit(["hash-object", "-w", "--stdin"], content);
        fixtureGit(["update-index", "-z", "--index-info"], `${mode} ${blob}\t${path}\0`);
    };

    beforeEach(async () => {
        directory = await mkdtemp("/tmp/stoat-git-test-");
        network.fixture = join(directory, "remote.git");
        fixtureGit(["init", "--bare", "--template=", network.fixture]);
        addFixture("compose.yaml", "services:\n  web:\n    image: nginx\n");
        addFixture("dir/--file [one] $(id).txt", "literal\n");
        addFixture("bin/run.sh", "#!/bin/sh\nexit 42\n", "100755");
        addFixture("link", "compose.yaml", "120000");
        addFixture("binary", Buffer.from([0xff, 0xfe]));
        addFixture("nul", Buffer.from([0]));
        addFixture(".gitattributes", "* filter=hostile\n");
        addFixture(
            ".gitmodules",
            '[submodule "module"]\n path = module\n url = file:///etc/passwd\n',
        );
        initial = commitFixture();
        fixtureGit(["update-index", "--add", "--cacheinfo", `160000,${initial},module`]);
        initial = commitFixture(initial);
        fixtureGit(["symbolic-ref", "HEAD", "refs/heads/main"]);
    });

    afterEach(async () => {
        for (const call of network.calls) expect(existsSync(call.env.HOME!)).toBe(false);
        network.fixture = "";
        await rm(directory, { recursive: true, force: true });
    });

    it.each(["master", "release/production"])(
        "discovers %s without assuming main or fetching, checking out, or pushing",
        async (branch) => {
            fixtureGit(["update-ref", `refs/heads/${branch}`, initial]);
            fixtureGit(["update-ref", "-d", "refs/heads/main"]);
            fixtureGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
            expect(await inspectGitRemote({ url: repo.url, credentials: {} })).toEqual({
                defaultBranch: branch,
            });
            expect(network.calls.map((call) => call.args[4])).toEqual([
                "--version",
                "init",
                "ls-remote",
            ]);
            expect(network.calls.at(-1)!.args.slice(4)).toEqual([
                "ls-remote",
                "--symref",
                repo.url,
                "HEAD",
            ]);
        },
    );

    it.each(["missing", "detached"])(
        "rejects a %s remote HEAD with actionable advice",
        async (head) => {
            if (head === "missing") fixtureGit(["symbolic-ref", "HEAD", "refs/heads/missing"]);
            else fixtureGit(["update-ref", "--no-deref", "HEAD", initial]);
            await expect(
                inspectGitRemote({ url: repo.url, credentials: {} }),
            ).rejects.toMatchObject({
                code: "BAD_GATEWAY",
                message: expect.stringMatching(/initialize the repository.*remote HEAD/u),
            });
            expect(network.calls.some((call) => call.args.includes("fetch"))).toBe(false);
        },
    );

    it.each([
        "secret-token\n",
        "ref: refs/tags/secret-token\tHEAD\n",
        "ref: refs/heads/secret-token..bad\tHEAD\n",
        "ref: refs/heads/secret-token\tHEAD\nref: refs/heads/other\tHEAD\n",
        "ref: refs/heads/-secret-token\tHEAD\n",
        "ref: refs/heads/secret-token\0\tHEAD\n",
        `ref: refs/heads/${"a".repeat(256)}\tHEAD\n`,
        Buffer.from("ref: refs/heads/secret-token\xff\tHEAD\n", "latin1"),
    ])("rejects malformed HEAD output without reflecting it (%#)", async (output) => {
        network.headOutput = Buffer.from(output);
        const result = inspectGitRemote({ url: repo.url, credentials: {} });
        await expect(result).rejects.toMatchObject({
            code: "BAD_GATEWAY",
            message: expect.stringContaining("remote HEAD"),
        });
        await expect(result).rejects.not.toThrow("secret-token");
        await expect(result).rejects.not.toHaveProperty("cause");
    });

    it("lists all regular files, excluding symlinks/submodules, from a shallow bare snapshot", async () => {
        const result = await listGitFiles(repo);
        expect(result).toEqual({
            revision: initial,
            files: [
                ".gitattributes",
                ".gitmodules",
                "bin/run.sh",
                "binary",
                "compose.yaml",
                "dir/--file [one] $(id).txt",
                "nul",
            ],
        });
        const fetch = network.calls.find((call) => call.args.includes("fetch"))!;
        expect(fetch.args).toEqual(
            expect.arrayContaining(["--depth=1", "--no-tags", "--no-recurse-submodules"]),
        );
        expect(
            network.calls.some(
                (call) => call.args.includes("checkout") || call.args.includes("clone"),
            ),
        ).toBe(false);
    });

    it("reads the original commit even when the remote advances after resolution", async () => {
        let advanced = false;
        network.beforeCommand = (args) => {
            if (!advanced && args.includes("ls-tree")) {
                advanced = true;
                addFixture("compose.yaml", "changed remotely\n");
                commitFixture(initial);
            }
        };

        expect(await readGitFile(repo, "compose.yaml")).toEqual({
            revision: initial,
            path: "compose.yaml",
            content: "services:\n  web:\n    image: nginx\n",
        });
        expect(fixtureGit(["rev-parse", "refs/heads/main"])).not.toBe(initial);
    });

    it("reads literal paths and rejects missing, non-regular and binary files", async () => {
        expect((await readGitFile(repo, "dir/--file [one] $(id).txt")).content).toBe("literal\n");
        await expect(readGitFile(repo, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });

        for (const path of ["link", "module", "bin", "binary", "nul"])
            await expect(readGitFile(repo, path)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("preserves UTF-8 BOM and accepts exactly 1 MiB, but rejects larger blobs", async () => {
        addFixture("bom.txt", Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
        addFixture("limit.txt", "a".repeat(1024 * 1024));
        addFixture("large.txt", "a".repeat(1024 * 1024 + 1));
        commitFixture(initial);
        expect((await readGitFile(repo, "bom.txt")).content).toBe("\ufeffa");
        expect((await readGitFile(repo, "limit.txt")).content.length).toBe(1024 * 1024);
        await expect(readGitFile(repo, "large.txt")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("writes existing and new files with plumbing, preserving mode and all other entries", async () => {
        const result = await pushGitFile(repo, {
            path: "bin/run.sh",
            content: "replacement\n",
            expectedRevision: initial,
            message: "Update file",
            author,
        });

        expect(fixtureGit(["rev-parse", "refs/heads/main"])).toBe(result.revision);
        expect(fixtureGit(["rev-parse", `${result.revision}^`])).toBe(initial);
        expect(fixtureGit(["show", "-s", "--format=%P", result.revision])).toBe(initial);
        expect(fixtureGit(["ls-tree", result.revision, "bin/run.sh"])).toMatch(/^100755 blob/u);
        expect(fixtureGit(["show", `${result.revision}:compose.yaml`])).toContain("image: nginx");
        expect(fixtureGit(["show", "-s", "--format=%an <%ae>", result.revision])).toBe(
            "Test Author <test@example.com>",
        );

        const next = await pushGitFile(repo, {
            path: "new/--file [x] $(id).txt",
            content: "new file\n",
            expectedRevision: result.revision,
            message: "Create file",
            author,
        });

        expect(fixtureGit(["show", `${next.revision}:new/--file [x] $(id).txt`])).toBe("new file");
        expect(fixtureGit(["show", "-s", "--format=%P", next.revision])).toBe(result.revision);
        const pushes = network.calls.filter((call) => call.args.includes("push"));
        expect(pushes).toHaveLength(2);
        expect(pushes[0]!.args).toContain(`--force-with-lease=refs/heads/main:${initial}`);
        expect(pushes[1]!.args).toContain(`--force-with-lease=refs/heads/main:${result.revision}`);

        for (const push of pushes) {
            expect(push.args).not.toContain("--force");
            expect(push.args).not.toContain("-f");
            expect(push.args.some((arg) => arg.startsWith("+"))).toBe(false);
            expect(push.args.filter((arg) => arg.startsWith("--force-with-lease"))).toHaveLength(1);
        }
    });

    it("rejects stale revisions before any blob/index/commit writes or push", async () => {
        await expect(
            pushGitFile(repo, {
                path: "compose.yaml",
                content: "no\n",
                expectedRevision: "a".repeat(40),
                message: "No",
                author,
            }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
            network.calls.some((call) =>
                call.args.some((arg) =>
                    ["hash-object", "read-tree", "update-index", "commit-tree", "push"].includes(
                        arg,
                    ),
                ),
            ),
        ).toBe(false);
        expect(fixtureGit(["rev-parse", "refs/heads/main"])).toBe(initial);
    });

    it("rejects a push race without overwriting the concurrent commit", async () => {
        let concurrent = "";
        network.beforeCommand = (args) => {
            if (args.includes("push")) {
                addFixture("compose.yaml", "concurrent\n");
                concurrent = commitFixture(initial);
            }
        };

        await expect(
            pushGitFile(repo, {
                path: "compose.yaml",
                content: "ours\n",
                expectedRevision: initial,
                message: "Ours",
                author,
            }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(fixtureGit(["rev-parse", "refs/heads/main"])).toBe(concurrent);
        expect(fixtureGit(["show", `${concurrent}:compose.yaml`])).toBe("concurrent");
    });

    it.each(["deletion", "rewind"])(
        "rejects branch %s between fetch and push with an exact-OID lease",
        async (race) => {
            const parent = fixtureGit(["rev-parse", `${initial}^`]);
            let raced = false;
            network.beforeCommand = (args) => {
                if (args.includes("push")) {
                    raced = true;

                    if (race === "deletion")
                        fixtureGit(["update-ref", "-d", "refs/heads/main", initial]);
                    else fixtureGit(["update-ref", "refs/heads/main", parent, initial]);
                }
            };

            await expect(
                pushGitFile(repo, {
                    path: "compose.yaml",
                    content: "ours\n",
                    expectedRevision: initial,
                    message: "Ours",
                    author,
                }),
            ).rejects.toMatchObject({ code: "CONFLICT" });
            expect(raced).toBe(true);
            expect(fixtureGit(["for-each-ref", "--format=%(objectname)", "refs/heads/main"])).toBe(
                race === "deletion" ? "" : parent,
            );
        },
    );

    it("rejects symlinks, submodules and file parents without pushing", async () => {
        for (const path of [
            "link",
            "module",
            "link/child",
            "module/child",
            "compose.yaml/child",
            "bin",
        ]) {
            await expect(
                pushGitFile(repo, {
                    path,
                    content: "no\n",
                    expectedRevision: initial,
                    message: "No",
                    author,
                }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        }

        expect(network.calls.some((call) => call.args.includes("push"))).toBe(false);
    });

    it("rejects malformed writes before any process or network access", async () => {
        const valid = {
            path: "file",
            content: "text",
            expectedRevision: initial,
            message: "Update",
            author,
        };

        for (const input of [
            { ...valid, content: "a".repeat(1024 * 1024 + 1) },
            { ...valid, content: "\ud800" },
            { ...valid, content: "\0" },
            { ...valid, expectedRevision: "HEAD" },
            { ...valid, message: "bad\0message" },
            { ...valid, author: { ...author, name: "bad\nname" } },
            { ...valid, path: "../outside" },
        ])
            await expect(pushGitFile(repo, input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(spawn).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
    });

    it("bounds file enumeration instead of returning a partial list", async () => {
        const blob = fixtureGit(["hash-object", "-w", "--stdin"], "small");
        fixtureGit(
            ["update-index", "-z", "--index-info"],
            Array.from({ length: 10_001 }, (_, i) => `100644 ${blob}\tfiles/${i}.txt\0`).join(""),
        );
        commitFixture(initial);
        await expect(listGitFiles(repo)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it.each([listGitFiles, inspectGitRemote])(
        "%s pins HTTPS DNS once, keeps basic credentials out of args/env, and sanitizes inherited configuration",
        async (operation) => {
            for (const key of [
                "GIT_CONFIG_COUNT",
                "GIT_SSH",
                "GIT_SSH_COMMAND",
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_TRACE",
                "GIT_SSL_NO_VERIFY",
                "SSH_AUTH_SOCK",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "LD_PRELOAD",
            ])
                vi.stubEnv(key, "hostile");

            const authenticated = {
                ...repo,
                credentials: {
                    username: "user",
                    password: "secret-token",
                    oauthProviderId: "provider-id",
                    refreshToken: "secret-refresh-token",
                    expiresAt: "2026-09-21T00:00:00.000Z",
                },
            };

            await operation(authenticated);
            expect(lookup).toHaveBeenCalledTimes(1);

            for (const call of network.calls) {
                expect(call.config).toContain(
                    'curloptResolve = "git.example.com:443:93.184.216.34"',
                );
                expect(call.config).toContain(
                    `Authorization: Basic ${Buffer.from("user:secret-token").toString("base64")}`,
                );
                expect(call.config).toContain("followRedirects = false");
                expect(call.config).toContain("hooksPath = /dev/null");
                expect(call.config).toContain("helper =\n");
                expect(call.config).toContain("allow = never");
                expect(JSON.stringify([call.args, call.env])).not.toContain("secret-token");
                expect(JSON.stringify(call)).not.toContain("secret-refresh-token");
                expect(JSON.stringify([call.args, call.env])).not.toContain(
                    Buffer.from("user:secret-token").toString("base64"),
                );
                expect(Object.values(call.env)).not.toContain("hostile");
                expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
                expect(call.env.GIT_ALLOW_PROTOCOL).toBe("https");
                expect(call.modes).toEqual([0o600]);
            }
        },
    );

    it.each([listGitFiles, inspectGitRemote])(
        "%s pins SSH IP while verifying the real hostname against explicit protected known_hosts",
        async (operation) => {
            const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n";
            const knownHosts = "[git.example.com]:2222 ssh-ed25519 AAAATEST\n";
            await operation({
                ...repo,
                url: "ssh://deploy@git.example.com:2222/team/repo.git",
                credentials: { privateKey, knownHosts },
            });
            expect(lookup).toHaveBeenCalledTimes(1);

            for (const call of network.calls) {
                expect(call.sshConfig).toContain("Hostname 93.184.216.34");
                expect(call.sshConfig).toContain("HostKeyAlias [git.example.com]:2222");
                expect(call.sshConfig).toContain("User deploy");
                expect(call.sshConfig).toContain("Port 2222");
                expect(call.sshConfig).toContain("StrictHostKeyChecking yes");
                expect(call.sshConfig).toContain("IdentityAgent none");
                expect(call.sshConfig).toContain("ProxyCommand none");
                expect(call.env.GIT_SSH_COMMAND).toMatch(/^ssh -F '/u);
                expect(call.env.GIT_ALLOW_PROTOCOL).toBe("ssh");
                expect(call.modes).toEqual([0o600, 0o600, 0o600, 0o600]);
                expect(JSON.stringify([call.args, call.env])).not.toContain(privateKey);
                expect(call.args.join(" ")).not.toContain("deploy@");
            }
        },
    );

    it.each([
        ["", false],
        [":22", false],
        [":2222", false],
        [":2222", true],
    ])("matches OpenSSH known_hosts using port %s (hashed: %s)", async (port, hashed) => {
        const keyPath = join(directory, "host-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], {
            timeout: 5000,
        });
        const alias = port === ":2222" ? "[git.example.com]:2222" : "git.example.com";
        const hostsPath = join(directory, "hosts");
        await writeFile(hostsPath, `${alias} ${readFileSync(`${keyPath}.pub`, "utf8")}`);

        if (hashed)
            execFileSync("ssh-keygen", ["-H", "-f", hostsPath], { stdio: "pipe", timeout: 5000 });
        const knownHosts = readFileSync(hostsPath, "utf8");

        if (hashed) expect(knownHosts).toMatch(/^\|1\|/u);
        let checked = false;
        network.beforeCommand = (args) => {
            if (!args.includes("fetch")) return;
            checked = true;
            const call = network.calls.at(-1)!;

            const options = {
                env: call.env,
                encoding: "utf8" as const,
                stdio: "pipe" as const,
                timeout: 5000,
            };

            const resolved = execFileSync(
                "ssh",
                ["-G", "-F", join(call.env.HOME!, "ssh_config"), "git.example.com"],
                options,
            );

            const resolvedAlias = /^hostkeyalias (.+)$/mu.exec(resolved)?.[1];
            expect(resolvedAlias).toBe(alias);
            expect(resolved).toMatch(/^hostname 93\.184\.216\.34$/mu);

            const matched = execFileSync(
                "ssh-keygen",
                ["-F", resolvedAlias!, "-f", join(call.env.HOME!, "known_hosts")],
                options,
            );

            expect(matched).toContain(knownHosts.trim());
        };

        await listGitFiles({
            ...repo,
            url: `ssh://git@git.example.com${port}/team/repo.git`,
            credentials: { privateKey: "test key", knownHosts },
        });
        expect(checked).toBe(true);
    });

    it.each([
        ["git@github.com:team/repo.git", "team/repo.git"],
        ["ssh://git@git.example.com:2222/~/team/repo.git", "team/repo.git"],
        ["git@git.example.com:/srv/repo.git", "/srv/repo.git"],
        ["ssh://git@git.example.com/srv/repo.git", "/srv/repo.git"],
    ])("passes the intended repository path to Git's SSH transport for %s", async (url, path) => {
        let checked = false;
        network.beforeCommand = (args) => {
            const fetch = args.indexOf("fetch");

            if (fetch < 0) return;
            checked = true;
            const call = network.calls.at(-1)!;

            // --diag-url parses the real Git SSH transport without opening a connection.
            const diagnostic = execFileSync(
                "git",
                ["--git-dir", network.fixture, "fetch-pack", "--diag-url", args.at(-2)!],
                {
                    env: call.env,
                    encoding: "utf8",
                    stdio: "pipe",
                    timeout: 5000,
                },
            );

            expect(diagnostic).toContain(`Diag: path=${path}\n`);
            expect(diagnostic).toContain("Diag: protocol=ssh\n");

            if (url.includes(":2222")) expect(call.sshConfig).toContain("Port 2222\n");
        };

        await listGitFiles({
            ...repo,
            url,
            credentials: { privateKey: "test key", knownHosts: "test host" },
        });
        expect(checked).toBe(true);
    });

    it.each([listGitFiles, inspectGitRemote])(
        "%s requires explicit SSH host keys and rejects cross-protocol credentials",
        async (operation) => {
            for (const credentials of [
                {},
                { privateKey: "key" },
                { privateKey: "key", knownHosts: " " },
                { privateKey: "key", knownHosts: "host", password: "pw" },
            ]) {
                await expect(
                    operation({ ...repo, url: "ssh://git@git.example.com/repo", credentials }),
                ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            }

            await expect(
                operation({ ...repo, credentials: { privateKey: "key" } }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(spawn).not.toHaveBeenCalled();
        },
    );

    it.each([listGitFiles, inspectGitRemote])(
        "%s rejects mixed public/private DNS and metadata answers, even when allowlisted",
        async (operation) => {
            for (const address of [
                "127.0.0.1",
                "169.254.169.254",
                "100.100.100.200",
                "168.63.129.16",
                "::1",
                "::ffff:10.1.2.3",
            ]) {
                vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "git.example.com");
                network.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
                await expect(operation(repo)).rejects.toMatchObject({ code: "BAD_REQUEST" });
            }

            vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "");
            network.addresses = [
                { address: "93.184.216.34", family: 4 },
                { address: "10.1.2.3", family: 4 },
            ];
            await expect(operation(repo)).rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(spawn).not.toHaveBeenCalled();
        },
    );

    it("allows private DNS only by exact URL host, not suffix or resolved IP", async () => {
        network.addresses = [{ address: "10.1.2.3", family: 4 }];

        for (const allowed of ["example.com", "*.example.com", "10.1.2.3", "git.example.com:443"]) {
            vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", allowed);
            await expect(listGitFiles(repo)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        }

        vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "other.internal, GIT.EXAMPLE.COM.");
        await listGitFiles(repo);
        expect(network.calls[0]!.config).toContain(
            'curloptResolve = "git.example.com:443:10.1.2.3"',
        );
    });

    it("pins IPv6 without permitting a DNS rebinding fallback", async () => {
        network.addresses = [{ address: "2606:4700:4700::1111", family: 6 }];
        network.beforeCommand = () => {
            network.addresses = [{ address: "127.0.0.1", family: 4 }];
        };

        await listGitFiles(repo);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(network.calls[0]!.config).toContain(
            'curloptResolve = "git.example.com:443:[2606:4700:4700::1111]"',
        );
    });

    it.each([listGitFiles, inspectGitRemote])(
        "%s does not return raw transport errors and cleans up failed operations",
        async (operation) => {
            network.failTransport = true;
            const result = operation({ ...repo, credentials: { password: "secret-token" } });
            await expect(result).rejects.toMatchObject({ code: "BAD_GATEWAY" });
            await expect(result).rejects.not.toThrow("secret-token");
            await expect(result).rejects.not.toHaveProperty("cause");
        },
    );

    it.each([listGitFiles, inspectGitRemote])(
        "%s fails closed on old Git versions before network transport",
        async (operation) => {
            network.version = "git version 2.29.0\n";
            await expect(operation(repo)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
            expect(network.calls.some((call) => call.args.includes("fetch"))).toBe(false);
            expect(network.calls.some((call) => call.args.includes("ls-remote"))).toBe(false);
        },
    );

    it.each([listGitFiles, inspectGitRemote])(
        "%s kills the process group on timeout and removes temporary credentials",
        async (operation) => {
            network.transportBehavior = "hang";
            const original = globalThis.setTimeout;

            // SAFETY: the wrapper forwards the timer callback and arguments unchanged, only shortening the timeout.
            const timeout = vi
                .spyOn(globalThis, "setTimeout")
                .mockImplementation(((
                    fn: (...args: unknown[]) => void,
                    ms?: number,
                    ...args: unknown[]
                ) => original(fn, ms === 30_000 ? 100 : ms, ...args)) as typeof setTimeout);

            const kill = vi.spyOn(process, "kill");

            try {
                await expect(operation(repo)).rejects.toMatchObject({ code: "TIMEOUT" });
                expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
                expect(kill.mock.calls[0]![0]).toBeLessThan(0);
            } finally {
                timeout.mockRestore();
                kill.mockRestore();
            }
        },
    );

    it.each(["stdout", "stderr", "disk"])(
        "bounds %s from the Git process and cleans up",
        async (behavior) => {
            network.transportBehavior = behavior;
            await expect(listGitFiles(repo)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
            await expect(inspectGitRemote(repo)).rejects.toMatchObject({
                code: "PAYLOAD_TOO_LARGE",
            });
        },
    );

    it("uses literal public IPs without DNS, including IPv6 and custom ports", async () => {
        for (const host of ["93.184.216.34", "[2606:4700:4700::1111]"]) {
            await listGitFiles({ ...repo, url: `https://${host}:8443/team/repo.git` });
        }

        expect(lookup).not.toHaveBeenCalled();
        expect(network.calls.every((call) => !call.config.includes("curloptResolve"))).toBe(true);
    });

    it("ignores hostile user Git config and never checks out executable repository content", async () => {
        await writeFile(
            join(directory, ".gitconfig"),
            '[url "file:///etc/passwd"]\n insteadOf = https://\n[core]\n hooksPath = /tmp/hostile\n',
        );
        vi.stubEnv("HOME", directory);
        await listGitFiles(repo);
        expect(network.calls.every((call) => call.env.HOME !== directory)).toBe(true);
    });
});
