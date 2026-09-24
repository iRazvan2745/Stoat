import { lookup } from "node:dns/promises";
import { Agent, request } from "node:https";
import type { RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Reply = {
    data?: unknown;
    status?: number;
    headers?: Record<string, string>;
    chunks?: Buffer[];
    behavior?: "hang" | "error" | "aborted" | "close" | "throw";
};

const network = vi.hoisted(() => ({
    addresses: [{ address: "93.184.216.34", family: 4 }],
    reply: (_url: URL): Reply => ({ data: {} }),
    // SAFETY: only the transport mock below appends these request records.
    calls: [] as {
        url: URL;
        options: RequestOptions;
        body?: string;
        destroy: ReturnType<typeof vi.fn>;
    }[],
}));

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

vi.mock("node:https", async () => {
    const actual = await vi.importActual<typeof import("node:https")>("node:https");
    const { EventEmitter } = await import("node:events");

    return {
        ...actual,
        request: vi.fn(
            (
                url: URL,
                options: RequestOptions,
                callback: (
                    res: Pick<
                        IncomingMessage,
                        "on" | "destroy" | "statusCode" | "headers" | "complete"
                    >,
                ) => void,
            ) => {
                const reply = network.reply(url);

                if (reply.behavior === "throw") throw new Error("secret-token request URL");

                const req = Object.assign(new EventEmitter(), {
                    destroy: vi.fn(),
                    end: (_body?: string) => {},
                });

                req.end = (body) => {
                    network.calls.push({ url, options, body, destroy: req.destroy });
                    void Promise.resolve().then(() => {
                        if (reply.behavior === "hang") return;

                        if (reply.behavior === "error") {
                            req.emit("error", new Error("secret-token TLS error URL"));

                            return;
                        }

                        const res = Object.assign(new EventEmitter(), {
                            statusCode: reply.status ?? 200,
                            headers: { "content-type": "application/json", ...reply.headers },
                            complete: false,
                            destroy: vi.fn(),
                        });

                        callback(res);

                        if (reply.behavior === "aborted" || reply.behavior === "close") {
                            res.emit(reply.behavior);

                            return;
                        }

                        for (const chunk of reply.chunks ?? [
                            Buffer.from(JSON.stringify(reply.data ?? {})),
                        ]) {
                            res.emit("data", chunk);
                        }

                        res.complete = true;
                        res.emit("end");
                        res.emit("close");
                    });
                };

                return req;
            },
        ),
    };
});

import {
    getGitAccount,
    gitProviderRequest,
    listGitRepositories,
    validateGitServerUrl,
} from "../../packages/api/src/git-provider";
import type { GitProvider } from "../../packages/api/src/git-provider";

const github = {
    provider: "github" as const,
    serverUrl: "https://github.com",
    token: "secret-token",
};

const forgejo = {
    provider: "forgejo" as const,
    serverUrl: "https://git.example.com/forge",
    token: "secret-token",
};

function repo(index: number, server = "https://github.com") {
    return {
        name: `repo-${index}`,
        full_name: `team/repo-${index}`,
        clone_url: `${server}/team/repo-${index}.git`,
        default_branch: "release/stable",
        token: "must-not-return",
    };
}

beforeEach(() => {
    vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "");
    network.addresses = [{ address: "93.184.216.34", family: 4 }];
    network.reply = () => ({ data: {} });
    network.calls = [];
    // SAFETY: production always requests { all: true }; vi.mocked exposes the last overload.
    vi.mocked(lookup)
        .mockReset()
        .mockImplementation(async () => network.addresses as never);
    vi.mocked(request).mockClear();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe("Git server validation", () => {
    it("exports exactly the agreed runtime API", async () => {
        expect(Object.keys(await import("../../packages/api/src/git-provider")).sort()).toEqual([
            "getGitAccount",
            "gitProviderRequest",
            "listGitRepositories",
            "validateGitServerUrl",
        ]);
    });

    it.each([
        ["https://GitHub.COM:443/", "github", "https://github.com"],
        ["https://GIT.example.com./forge/team/", "forgejo", "https://git.example.com/forge/team"],
        ["https://git.example.com:8443/forge", "forgejo", "https://git.example.com:8443/forge"],
        ["https://git.example.com", "generic", "https://git.example.com"],
        ["ssh://git.example.com:2222/", "generic", "ssh://git.example.com:2222"],
        ["https://git.example.com/%66orge/", "forgejo", "https://git.example.com/forge"],
    ] as const)("normalizes %s as %s", (url, provider, expected) => {
        expect(validateGitServerUrl(url, provider)).toBe(expected);
        expect(validateGitServerUrl(expected, provider)).toBe(expected);
    });

    it.each([
        "http://git.example.com",
        "ssh://git.example.com",
        "git@git.example.com:forge",
        "https://user:secret@git.example.com",
        "https://user@git.example.com",
        "https://@git.example.com",
        "https://git.example.com?token=secret",
        "https://git.example.com?",
        "https://git.example.com#",
        "https://git.example.com\\@evil.example",
        "https://git.example.com/forge\n",
        "https://git.example.com:0",
        "https://bad_host.example",
        "https:///git.example.com",
        "https://git.example.com/a/../forge",
        "https://git.example.com/a/./forge",
        "https://git.example.com/a/%2e%2e/forge",
        "https://git.example.com/a/%252e%252e/forge",
        "https://git.example.com/forge%2fadmin",
        "https://git.example.com/forge//admin",
        "https://git.example.com/%00",
        "https://git.example.com/%zz",
        "https://git.example.com/%5cadmin",
    ])("rejects unsafe server URL %s", (url) => {
        expect(() => validateGitServerUrl(url, "forgejo")).toThrow();
    });

    it("does not accept GitLab or public GitHub API prefixes/alternate ports", () => {
        // SAFETY: intentionally unsupported provider exercises runtime validation.
        expect(() => validateGitServerUrl("https://gitlab.com", "gitlab" as GitProvider)).toThrow();
        expect(() => validateGitServerUrl("https://github.com/api/v3", "github")).toThrow();
        expect(() => validateGitServerUrl("https://github.com:8443", "github")).toThrow();
    });

    it("rejects Gitea as a runtime provider", () => {
        // SAFETY: intentionally unsupported provider exercises runtime validation.
        expect(() => validateGitServerUrl(forgejo.serverUrl, "gitea" as GitProvider)).toThrow();
    });

    it("rejects long invalid paths without pathological regex backtracking", () => {
        expect(() =>
            validateGitServerUrl(`https://git.example.com/${"a".repeat(3000)}!`, "forgejo"),
        ).toThrow();
    });

    it.each([
        "localhost",
        "a.localhost",
        "metadata.google.internal",
        "127.0.0.1",
        "127.1",
        "2130706433",
        "0x7f000001",
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
    ])("blocks special host %s even when allowlisted", (host) => {
        vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", host);
        expect(() => validateGitServerUrl(`https://${host}`, "forgejo")).toThrow();
    });
});

describe("Pinned HTTPS JSON transport", () => {
    it("pins the validated address and retains hostname TLS verification without proxy inheritance", async () => {
        vi.stubEnv("HTTPS_PROXY", "http://secret:password@127.0.0.1:1234");
        vi.stubEnv("NODE_USE_ENV_PROXY", "1");
        vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
        network.addresses.push({ address: "2606:4700:4700::1111", family: 6 });
        await expect(gitProviderRequest("https://git.example.com/api/v1/user")).resolves.toEqual(
            {},
        );
        expect(lookup).toHaveBeenCalledExactlyOnceWith("git.example.com", {
            all: true,
            verbatim: true,
        });
        const { url, options, destroy } = network.calls[0]!;
        expect(url.hostname).toBe("git.example.com");
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.family).toBe(4);
        assert(options.agent instanceof Agent);
        expect(options.agent.options.proxyEnv).toEqual({});
        const pinnedLookup = options.lookup!;
        network.addresses = [{ address: "127.0.0.1", family: 4 }];
        const callback = vi.fn();
        pinnedLookup("git.example.com", {}, callback);
        expect(callback).toHaveBeenLastCalledWith(null, "93.184.216.34", 4);
        pinnedLookup("git.example.com", { all: true }, callback);
        expect(callback).toHaveBeenLastCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(destroy).toHaveBeenCalled();
    });

    it("supports OAuth form POST bodies and JSON responses", async () => {
        network.reply = () => ({ data: { access_token: "new-token", token_type: "bearer" } });
        const body = "client_id=id&client_secret=secret&code=code";
        await expect(
            gitProviderRequest("https://github.com/login/oauth/access_token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            }),
        ).resolves.toEqual({ access_token: "new-token", token_type: "bearer" });
        expect(network.calls[0]!.body).toBe(body);
        expect(network.calls[0]!.options.headers).toMatchObject({
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(Buffer.byteLength(body)),
            "accept-encoding": "identity",
        });
    });

    it.each(["10.1.2.3", "172.16.0.1", "192.168.1.1", "fd12::1"])(
        "requires an exact allowlist for private DNS %s",
        async (address) => {
            network.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];

            for (const allow of [
                "",
                "*.example.com",
                "example.com",
                address,
                "git.example.com:443",
            ]) {
                vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", allow);
                await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow();
            }

            expect(request).not.toHaveBeenCalled();
            vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "other.example, GIT.EXAMPLE.COM.");
            await expect(gitProviderRequest("https://git.example.com/user")).resolves.toEqual({});
        },
    );

    it.each([
        "127.0.0.1",
        "169.254.169.254",
        "168.63.129.16",
        "100.100.100.200",
        "0.0.0.0",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "::1",
        "::ffff:10.1.2.3",
        "fe80::1",
        "fd00:ec2::254",
        "fd20:ce::254",
        "64:ff9b::1",
        "2001::1",
        "2001:db8::1",
        "2002::1",
        "3fff::1",
        "not-an-address",
    ])("rejects all DNS records if any answer is unsafe: %s", async (address) => {
        vi.stubEnv("STOAT_GIT_ALLOWED_HOSTS", "git.example.com");
        network.addresses.push({ address, family: address.includes(":") ? 6 : 4 });
        await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it("rejects empty and excessively large DNS answers", async () => {
        for (const addresses of [
            [],
            Array.from({ length: 65 }, () => ({ address: "93.184.216.34", family: 4 })),
        ]) {
            network.addresses = addresses;
            await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow();
        }

        expect(request).not.toHaveBeenCalled();
    });

    it.each(["93.184.216.34", "[2606:4700:4700::1111]"])(
        "uses literal public addresses without DNS: %s",
        async (host) => {
            await gitProviderRequest(`https://${host}/user`);
            expect(lookup).not.toHaveBeenCalled();
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it.each([301, 302, 303, 307, 308, 400, 401, 403, 404, 429, 500])(
        "rejects HTTP %s without leaking bodies or following redirects",
        async (status) => {
            network.reply = () => ({
                status,
                data: { error: "secret-token" },
                headers: { location: "https://evil.example/secret-token" },
            });

            const error = await gitProviderRequest(
                "https://git.example.com/user?code=secret-token",
            ).catch((error: Error) => error);

            expect(error).toMatchObject({
                code: "BAD_GATEWAY",
                message: "Git provider request failed",
            });
            assert(error instanceof Error);
            expect(error.cause).toBeUndefined();
            expect(JSON.stringify(error)).not.toContain("secret-token");
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it.each(["error", "aborted", "close", "throw"] as const)(
        "sanitizes %s failures",
        async (behavior) => {
            network.reply = () => ({ behavior });

            const error = await gitProviderRequest(
                "https://git.example.com/user?token=secret-token",
            ).catch((error: Error) => error);

            expect(error).toMatchObject({
                message: "Git provider request failed",
            });
            assert(error instanceof Error);
            expect(error.cause).toBeUndefined();
        },
    );

    it("rejects invalid JSON, invalid UTF-8, compressed and non-JSON responses", async () => {
        const replies: Reply[] = [
            { chunks: [Buffer.from("secret-token")] },
            { chunks: [Buffer.from([0xff])] },
            { headers: { "content-type": "text/html" } },
            { headers: { "content-encoding": "gzip" } },
        ];

        for (const reply of replies) {
            network.reply = () => reply;
            await expect(gitProviderRequest("https://git.example.com/user")).rejects.toMatchObject({
                code: "BAD_GATEWAY",
            });
        }
    });

    it("caps streamed output even without Content-Length", async () => {
        network.reply = () => ({
            chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024 + 1)],
        });
        await expect(gitProviderRequest("https://git.example.com/user")).rejects.toMatchObject({
            code: "PAYLOAD_TOO_LARGE",
        });
        expect(network.calls[0]!.destroy).toHaveBeenCalled();
    });

    it("bounds DNS resolution and sanitizes DNS failures", async () => {
        vi.useFakeTimers();
        vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));

        const pending = expect(
            gitProviderRequest("https://git.example.com/user"),
        ).rejects.toMatchObject({
            code: "BAD_GATEWAY",
            message: "Unable to resolve Git provider host",
        });

        await vi.advanceTimersByTimeAsync(5000);
        await pending;
        expect(request).not.toHaveBeenCalled();
        vi.mocked(lookup).mockRejectedValueOnce(new Error("secret-token"));
        await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow(
            "Unable to resolve Git provider host",
        );
    });

    it("has an absolute request deadline and destroys the socket", async () => {
        vi.useFakeTimers();
        network.reply = () => ({ behavior: "hang" });

        const pending = expect(
            gitProviderRequest("https://git.example.com/user"),
        ).rejects.toMatchObject({ code: "TIMEOUT" });

        await vi.advanceTimersByTimeAsync(15_000);
        await pending;
        expect(network.calls[0]!.destroy).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects unsafe headers, oversized bodies and non-HTTPS transport before DNS", async () => {
        const unsafeHeaders: Record<string, string>[] = [
            { Host: "evil.example" },
            { Authorization: "secret\r\nHost: evil.example" },
            { "Proxy-Authorization": "secret" },
            { "Transfer-Encoding": "chunked" },
            { "Content-Length": "1" },
        ];

        for (const headers of unsafeHeaders) {
            await expect(
                gitProviderRequest("https://git.example.com/user", { headers }),
            ).rejects.toThrow();
        }

        await expect(
            gitProviderRequest("https://git.example.com/user", {
                method: "POST",
                body: "x".repeat(65537),
            }),
        ).rejects.toThrow();
        await expect(
            gitProviderRequest("https://git.example.com/user", { body: "secret" }),
        ).rejects.toThrow();
        await expect(gitProviderRequest("http://git.example.com/user")).rejects.toThrow();
        expect(lookup).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });
});

describe("Account discovery", () => {
    it.each([
        [github, "https://api.github.com/user"],
        [
            { ...github, serverUrl: "https://github.enterprise.example" },
            "https://github.enterprise.example/api/v3/user",
        ],
        [
            { ...github, serverUrl: "https://github.com.example/forge" },
            "https://github.com.example/forge/api/v3/user",
        ],
        [forgejo, "https://git.example.com/forge/api/v1/user"],
    ])("uses the correct /user endpoint for %j", async (input, endpoint) => {
        network.reply = () => ({
            data: {
                id: 123,
                login: "alice.smith",
                name: "Alice",
                full_name: "Alice",
                token: "never-return",
            },
        });
        await expect(getGitAccount(input)).resolves.toEqual({
            id: "123",
            login: "alice.smith",
            name: "Alice",
        });
        expect(network.calls[0]!.url.toString()).toBe(endpoint);
        expect(network.calls[0]!.options.headers).toMatchObject({
            authorization: "Bearer secret-token",
        });
    });

    it.each([
        null,
        {},
        { id: {}, login: "alice" },
        { id: Number.MAX_SAFE_INTEGER + 1, login: "alice" },
        { id: 1, login: "alice:password" },
        { id: 1, login: "-option" },
        { id: 1, login: "alice\n" },
    ])("rejects invalid account data %j", async (data) => {
        network.reply = () => ({ data });
        await expect(getGitAccount(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    });

    it("preserves string IDs and drops unsafe optional display names", async () => {
        network.reply = () => ({
            data: { id: "9007199254740993", login: "alice", name: "unsafe\nname" },
        });
        await expect(getGitAccount(github)).resolves.toEqual({
            id: "9007199254740993",
            login: "alice",
            name: null,
        });
    });

    it("rejects generic discovery at runtime and in the public type", async () => {
        // @ts-expect-error Generic hosts do not provide an account API.
        await expect(getGitAccount({ ...github, provider: "generic" })).rejects.toThrow();
        // @ts-expect-error Generic hosts do not provide repository discovery.
        await expect(listGitRepositories({ ...github, provider: "generic" })).rejects.toThrow();
        await expect(getGitAccount({ ...github, token: "secret\n" })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });
});

describe("Repository discovery", () => {
    it("uses the Enterprise API while retaining the Enterprise clone origin", async () => {
        const server = "https://github.enterprise.example:8443";
        network.reply = (url) => ({
            data: url.searchParams.get("page") === "1" ? [repo(1, server)] : [],
        });
        await expect(listGitRepositories({ ...github, serverUrl: server })).resolves.toEqual({
            repositories: [
                {
                    url: `${server}/team/repo-1.git`,
                    name: "team/repo-1",
                    defaultBranch: "release/stable",
                },
            ],
            truncated: false,
        });
        expect(network.calls[0]!.url.origin).toBe(server);
        expect(network.calls[0]!.url.pathname).toBe("/api/v3/user/repos");
    });

    it("paginates all affiliations, ignores untrusted links and returns only sanitized fields", async () => {
        network.reply = (url) => ({
            data:
                Number(url.searchParams.get("page")) <= 2
                    ? [repo(Number(url.searchParams.get("page")))]
                    : [],
            headers: { link: '<https://evil.example/user/repos?page=2>; rel="next"' },
        });
        await expect(listGitRepositories(github)).resolves.toEqual({
            repositories: [1, 2].map((id) => ({
                url: repo(id).clone_url,
                name: repo(id).full_name,
                defaultBranch: "release/stable",
            })),
            truncated: false,
        });
        expect(network.calls).toHaveLength(3);

        for (const { url } of network.calls) {
            expect(url.origin).toBe("https://api.github.com");
            expect(url.pathname).toBe("/user/repos");
            expect(url.searchParams.get("affiliation")).toBe(
                "owner,collaborator,organization_member",
            );
            expect(url.searchParams.get("per_page")).toBe("100");
        }
    });

    it("keeps Forgejo path prefixes and continues server-capped short pages", async () => {
        network.reply = (url) => ({
            data:
                Number(url.searchParams.get("page")) <= 3
                    ? [repo(Number(url.searchParams.get("page")), forgejo.serverUrl)]
                    : [],
        });
        const result = await listGitRepositories(forgejo);
        expect(result.repositories).toHaveLength(3);
        expect(result.truncated).toBe(false);
        expect(network.calls).toHaveLength(4);
        expect(network.calls[0]!.url.pathname).toBe("/forge/api/v1/user/repos");
        expect(network.calls[0]!.url.searchParams.get("limit")).toBe("100");
    });

    it.each([999, 1000, 1001, 1200])(
        "reports truncation correctly for %s repositories",
        async (total) => {
            network.reply = (url) => {
                const start = (Number(url.searchParams.get("page")) - 1) * 100;

                return {
                    data: Array.from(
                        { length: Math.max(0, Math.min(100, total - start)) },
                        (_, i) => repo(start + i),
                    ),
                };
            };

            const result = await listGitRepositories(github);
            expect(result.repositories).toHaveLength(Math.min(total, 1000));
            expect(result.truncated).toBe(total > 1000);
            expect(network.calls.length).toBeLessThanOrEqual(11);
        },
    );

    it("bounds repeated pages without reporting a complete result", async () => {
        network.reply = () => ({ data: [repo(1)] });
        const result = await listGitRepositories(github);
        expect(result.repositories).toHaveLength(1);
        expect(result.truncated).toBe(true);
        expect(network.calls).toHaveLength(100);
    });

    it.each([
        "https://evil.example/forge/team/repo.git",
        "https://git.example.com/forge-other/team/repo.git",
        "https://git.example.com/team/repo.git",
        "https://git.example.com:8443/forge/team/repo.git",
        "http://git.example.com/forge/team/repo.git",
        "ssh://git.example.com/forge/team/repo.git",
        "https://secret@git.example.com/forge/team/repo.git",
        "https://git.example.com/forge/team/repo.git?token=secret",
        "https://git.example.com/forge/team/repo.git#fragment",
        "https://git.example.com/forge/../team/repo.git",
        "https://git.example.com/forge/%2e%2e/team/repo.git",
        "https://git.example.com/forge/",
    ])("rejects clone URL outside the configured trust boundary: %s", async (clone_url) => {
        network.reply = () => ({ data: [{ ...repo(1), clone_url }] });
        await expect(listGitRepositories(forgejo)).rejects.toMatchObject({
            code: "BAD_GATEWAY",
            message: "Invalid Git provider response",
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("does not allow api.github.com as a public GitHub clone origin", async () => {
        network.reply = () => ({ data: [repo(1, "https://api.github.com")] });
        await expect(listGitRepositories(github)).rejects.toThrow();
    });

    it.each([
        { message: "secret" },
        [null],
        [{}],
        [{ ...repo(1), default_branch: 123 }],
        [{ ...repo(1), default_branch: false }],
        [{ ...repo(1), default_branch: {} }],
        [{ ...repo(1), default_branch: [] }],
        [{ ...repo(1), default_branch: undefined }],
        [{ ...repo(1), full_name: "unsafe\nname" }],
    ])("rejects malformed repository data %j without silent omissions", async (data) => {
        network.reply = () => ({ data });
        await expect(listGitRepositories(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    });

    it.each([
        "refs/release",
        "-option",
        "HEAD",
        "",
        null,
        "unsafe\nbranch",
        "unsafe\0branch",
        "unsafe\x7fbranch",
        "a".repeat(256),
        "\u00e9".repeat(128),
        "\ud800",
    ])(
        "retains repositories with unavailable or unsupported default branch %j",
        async (default_branch) => {
            network.reply = (url) => ({
                data: url.searchParams.get("page") === "1" ? [{ ...repo(1), default_branch }] : [],
            });
            await expect(listGitRepositories(github)).resolves.toEqual({
                repositories: [
                    { url: repo(1).clone_url, name: repo(1).full_name, defaultBranch: "" },
                ],
                truncated: false,
            });
        },
    );

    it("lists empty and unsupported Forgejo repositories without blocking unrelated pages", async () => {
        network.reply = (url) => {
            const page = url.searchParams.get("page");

            if (page === "1")
                return {
                    data: ["refs/release", "", null].map((default_branch, i) => ({
                        ...repo(i, forgejo.serverUrl),
                        default_branch,
                    })),
                };

            return { data: page === "2" ? [repo(3, forgejo.serverUrl)] : [] };
        };

        await expect(listGitRepositories(forgejo)).resolves.toEqual({
            repositories: [0, 1, 2, 3].map((i) => ({
                url: repo(i, forgejo.serverUrl).clone_url,
                name: repo(i).full_name,
                defaultBranch: i === 3 ? "release/stable" : "",
            })),
            truncated: false,
        });
        expect(network.calls).toHaveLength(3);
    });

    it("does not return a partial success when a later page fails", async () => {
        network.reply = (url) =>
            Number(url.searchParams.get("page")) === 1
                ? { data: [repo(1)] }
                : { status: 500, data: "secret" };
        await expect(listGitRepositories(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    });
});
