import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { JSONType } from "zod";
import type { Context } from "../../packages/api/src/context";
import type { GitCredentials } from "../../packages/api/src/git";
import {
    assertGitOAuthConnection,
    assertGitOAuthOrigin,
    createGitOAuthFlow,
    exchangeGitOAuthCode,
    getGitOAuthCallbackUrl,
    getGitOAuthCookieConfig,
    getGitOAuthProviders,
    getPublicGitOAuthProviders,
    gitOAuthCookieName,
    gitOAuthCookieOptions,
    readGitOAuthFlow,
    refreshGitOAuthCredentials,
    requireGitOAuthAdmin,
} from "../../packages/api/src/git-oauth";
import {
    getGitAccount,
    gitProviderRequest,
    listGitRepositories,
} from "../../packages/api/src/git-provider";
import { decryptGitCredentials } from "../../packages/api/src/git-secrets";
import { member } from "@stoat/db/schema/auth";
import type { gitConnections } from "@stoat/db/schema/index";
import type { PgTable } from "drizzle-orm/pg-core";
import { POST } from "../../apps/web/src/routes/git/oauth/start/+server";
import { GET } from "../../apps/web/src/routes/git/oauth/callback/+server";

const mocks = vi.hoisted(() => ({
    membership: vi.fn(),
    session: vi.fn(),
    db: { select: vi.fn(), transaction: vi.fn() },
    insert: vi.fn(),
    update: vi.fn(),
    // SAFETY: fixtures below populate the connection fields read by the OAuth handlers.
    connection: undefined as Partial<typeof gitConnections.$inferSelect> | undefined,
    lockedRole: "admin",
}));

vi.mock("../../packages/api/src/git-provider", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../packages/api/src/git-provider")>()),
    getGitAccount: vi.fn(),
    gitProviderRequest: vi.fn(),
    listGitRepositories: vi.fn(),
}));

vi.mock("@stoat/db/organizations", () => ({ getOrganizationMembership: mocks.membership }));

vi.mock("../../apps/web/src/services", () => ({
    getDb: () => mocks.db,
    getAuth: () => ({ api: { getSession: mocks.session } }),
}));

const identity = { userId: "user-1", sessionId: "session-1", organizationId: "org-1" };

const provider = {
    id: "github",
    name: "GitHub",
    provider: "github" as const,
    serverUrl: "https://github.com",
    clientId: "client-id",
    clientSecret: "client-secret-never-return",
};

const account = { id: "42", login: "octocat", name: "Octocat" };

// SAFETY: OAuth authorization reads only these session/user identifiers.
const session = {
    user: { id: identity.userId },
    session: { id: identity.sessionId, activeOrganizationId: identity.organizationId },
} as Context["session"];

function configure(value: JSONType = [provider]) {
    vi.stubEnv("GIT_OAUTH_PROVIDERS", JSON.stringify(value));
}

function start() {
    const result = createGitOAuthFlow({ ...identity, providerId: "github", name: "Work" });
    const url = new URL(result.authorizationUrl);

    return { ...result, state: url.searchParams.get("state")!, url };
}

function event(url: string, request?: Request, cookie?: string) {
    const input = {
        url: new URL(url),
        request: request ?? new Request(url),
        cookies: {
            get: vi.fn((_name: string) => cookie),
            set: vi.fn<Parameters<typeof POST>[0]["cookies"]["set"]>(),
            delete: vi.fn(),
        },
    };

    // SAFETY: these handlers only read url/request/cookies; framework-only fields are unused.
    return input as typeof input & Parameters<typeof POST>[0];
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BETTER_AUTH_SECRET", "oauth-test-secret-that-is-at-least-32-bytes");
    vi.stubEnv("BETTER_AUTH_URL", "https://stoat.example.com");
    configure();
    mocks.membership.mockResolvedValue({ role: "admin" });
    mocks.session.mockResolvedValue(session);
    mocks.connection = undefined;
    mocks.lockedRole = "admin";
    mocks.db.select.mockImplementation(() => ({
        from: (table: PgTable) => ({
            where: () => ({
                orderBy: async () => [],
                limit: async () => (mocks.connection ? [mocks.connection] : []),
                for: async () =>
                    table === member
                        ? [{ role: mocks.lockedRole }]
                        : mocks.connection
                          ? [mocks.connection]
                          : [],
            }),
        }),
    }));
    mocks.db.transaction.mockImplementation(async (fn) =>
        fn({
            select: mocks.db.select,
            insert: () => ({ values: mocks.insert }),
            update: () => ({
                set: (value: Partial<typeof gitConnections.$inferInsert>) => ({
                    where: async () => mocks.update(value),
                }),
            }),
        }),
    );
    vi.mocked(gitProviderRequest).mockResolvedValue({
        access_token: "access-token-secret",
        token_type: "bearer",
    });
    vi.mocked(getGitAccount).mockResolvedValue(account);
    vi.mocked(listGitRepositories).mockResolvedValue({ repositories: [], truncated: false });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe("Git OAuth configuration", () => {
    it("exposes only public provider metadata", () => {
        expect(getGitOAuthProviders()).toEqual([provider]);
        expect(getPublicGitOAuthProviders()).toEqual([
            { id: "github", name: "GitHub", provider: "github", serverUrl: "https://github.com" },
        ]);
        expect(JSON.stringify(getPublicGitOAuthProviders())).not.toContain("client");
        vi.stubEnv("GIT_OAUTH_PROVIDERS", "");
        expect(getPublicGitOAuthProviders()).toEqual([]);
    });

    it.each([
        {},
        [{ ...provider, provider: "generic" }],
        [provider, provider],
        [{ ...provider, clientSecret: "" }],
        [{ ...provider, id: "../github" }],
        [{ ...provider, id: "db_reserved" }],
        [{ ...provider, serverUrl: "https://secret@github.com" }],
        [{ ...provider, serverUrl: "http://github.com" }],
        [{ ...provider, redirectUrl: "https://attacker.example" }],
    ])("rejects invalid configurations without exposing their contents", (value) => {
        configure(value);
        expect(() => getGitOAuthProviders()).toThrow(
            expect.objectContaining({ code: "configuration" }),
        );

        try {
            getGitOAuthProviders();
        } catch (error) {
            expect(String(error)).not.toContain(provider.clientSecret);
        }
    });

    it("rejects Gitea OAuth configuration", () => {
        configure([{ ...provider, provider: "gitea", serverUrl: "https://git.example.com/forge" }]);
        expect(() => getGitOAuthProviders()).toThrow(
            expect.objectContaining({ code: "configuration" }),
        );
    });

    it("reports malformed JSON and missing trusted app configuration", () => {
        vi.stubEnv("GIT_OAUTH_PROVIDERS", "not-json-client-secret");
        expect(() => getGitOAuthProviders()).toThrow("GIT_OAUTH_PROVIDERS");
        vi.stubEnv("BETTER_AUTH_URL", "");
        expect(() => getGitOAuthCallbackUrl()).toThrow("BETTER_AUTH_URL");
    });

    it.each([
        "http://stoat.example.com",
        "http://localhost.attacker.example",
        "ftp://localhost",
        "",
    ])("never selects an insecure cookie for invalid app configuration %s", (baseUrl) => {
        vi.stubEnv("BETTER_AUTH_URL", baseUrl);
        expect(() => getGitOAuthCookieConfig()).toThrow(
            expect.objectContaining({ code: "configuration" }),
        );
    });

    it("derives the exact callback from the trusted app base, never request headers", () => {
        vi.stubEnv("BETTER_AUTH_URL", "https://stoat.example.com/base/");
        expect(getGitOAuthCallbackUrl()).toBe("https://stoat.example.com/base/git/oauth/callback");

        const request = new Request("https://stoat.example.com/base/git/oauth/start", {
            method: "POST",
            headers: {
                origin: "https://stoat.example.com",
                "x-forwarded-host": "attacker.example",
            },
        });

        expect(() => assertGitOAuthOrigin(request)).not.toThrow();
        expect(new URL(start().authorizationUrl).searchParams.get("redirect_uri")).toBe(
            getGitOAuthCallbackUrl(),
        );
    });

    it.each([
        null,
        "null",
        "https://attacker.example",
        "https://stoat.example.com.attacker.example",
        "https://stoat.example.com/",
    ])("rejects an untrusted Origin %s", (origin) => {
        const request = new Request("https://stoat.example.com/git/oauth/start", {
            method: "POST",
            headers: origin ? { origin } : {},
        });

        expect(() => assertGitOAuthOrigin(request)).toThrow(
            expect.objectContaining({ code: "forbidden" }),
        );
    });
});

describe("Git OAuth state and authorization", () => {
    it("uses random state, S256 PKCE and an authenticated encrypted bounded cookie", () => {
        const flow = start();
        const decoded = readGitOAuthFlow(flow.cookie, flow.state, identity);
        expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(flow.url.searchParams.get("code_challenge")).toBe(
            createHash("sha256").update(decoded.verifier).digest("base64url"),
        );
        expect(flow.url.pathname).toBe("/login/oauth/authorize");
        expect(decoded.expiresAt - decoded.createdAt).toBe(600_000);
        expect(flow.cookie.length).toBeLessThan(3801);
        expect(flow.cookie).not.toContain(decoded.verifier);
        expect(flow.cookie).not.toContain(identity.userId);
        expect(start().state).not.toBe(flow.state);
        expect(gitOAuthCookieOptions).toEqual({
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            maxAge: 600,
        });
    });

    it("rejects tampering, missing state, wrong state, and oversize cookies", () => {
        const flow = start();

        for (const cookie of [
            undefined,
            "x".repeat(3801),
            flow.cookie.slice(0, -4),
            flow.cookie.replace(/^v1/, "v2"),
        ]) {
            expect(() => readGitOAuthFlow(cookie, flow.state, identity)).toThrow("invalid_state");
        }

        for (const state of [null, "x", "x".repeat(43), "x".repeat(10000)]) {
            expect(() => readGitOAuthFlow(flow.cookie, state, identity)).toThrow("invalid_state");
        }
    });

    it.each(["userId", "sessionId", "organizationId"])("binds state to the current %s", (field) => {
        const flow = start();
        expect(() =>
            readGitOAuthFlow(flow.cookie, flow.state, { ...identity, [field]: "other" }),
        ).toThrow("invalid_state");
    });

    it("rejects expiry, future-issued state and provider/app configuration changes", () => {
        vi.useFakeTimers();
        const now = Date.now();
        const flow = start();
        vi.setSystemTime(now + 600_000);
        expect(() => readGitOAuthFlow(flow.cookie, flow.state, identity)).toThrow("invalid_state");
        vi.setSystemTime(now - 1);
        expect(() => readGitOAuthFlow(flow.cookie, flow.state, identity)).toThrow("invalid_state");
        vi.setSystemTime(now);
        configure([{ ...provider, serverUrl: "https://github.example.com" }]);
        expect(() => readGitOAuthFlow(flow.cookie, flow.state, identity)).toThrow("invalid_state");
        configure();
        vi.stubEnv("BETTER_AUTH_URL", "https://other.example.com");
        expect(() => readGitOAuthFlow(flow.cookie, flow.state, identity)).toThrow("invalid_state");
    });

    it("requires an active session and current owner/admin membership", async () => {
        // SAFETY: organization membership is mocked; this test never performs database I/O.
        const db = mocks.db as Parameters<typeof requireGitOAuthAdmin>[0];
        await expect(requireGitOAuthAdmin(db, null)).rejects.toThrow("forbidden");
        await expect(
            requireGitOAuthAdmin(db, {
                ...session!,
                session: { ...session!.session, activeOrganizationId: null },
            }),
        ).rejects.toThrow("forbidden");
        mocks.membership.mockResolvedValue({ role: "member" });
        await expect(requireGitOAuthAdmin(db, session)).rejects.toThrow("forbidden");
        mocks.membership.mockResolvedValue(undefined);
        await expect(requireGitOAuthAdmin(db, session)).rejects.toThrow("forbidden");
        mocks.membership.mockResolvedValue({ role: "member, owner" });
        await expect(requireGitOAuthAdmin(db, session)).resolves.toEqual(identity);
    });

    it("requires immutable provider/server and same-organization connection ownership", () => {
        const connection = {
            organizationId: identity.organizationId,
            provider: provider.provider,
            serverUrl: provider.serverUrl,
        };

        expect(() =>
            assertGitOAuthConnection(connection, identity.organizationId, provider),
        ).not.toThrow();

        for (const invalid of [
            undefined,
            { ...connection, organizationId: "other" },
            { ...connection, serverUrl: "https://other.example" },
            { ...connection, provider: "forgejo" },
        ]) {
            expect(() =>
                assertGitOAuthConnection(invalid, identity.organizationId, provider),
            ).toThrow("connection_mismatch");
        }
    });
});

describe("Git OAuth exchange and refresh", () => {
    it("exchanges a code via pinned transport and verifies account and repository access", async () => {
        const flow = start();
        const state = readGitOAuthFlow(flow.cookie, flow.state, identity);
        const result = await exchangeGitOAuthCode(state, "provider-code");
        const [url, options] = vi.mocked(gitProviderRequest).mock.calls[0]!;
        expect(url).toBe("https://github.com/login/oauth/access_token");
        expect(options?.method).toBe("POST");
        expect(new URLSearchParams(options?.body)).toEqual(
            new URLSearchParams({
                grant_type: "authorization_code",
                code: "provider-code",
                redirect_uri: getGitOAuthCallbackUrl(),
                code_verifier: state.verifier,
                client_id: provider.clientId,
                client_secret: provider.clientSecret,
            }),
        );
        expect(getGitAccount).toHaveBeenCalledWith({
            provider: "github",
            serverUrl: provider.serverUrl,
            token: "access-token-secret",
        });
        expect(listGitRepositories).toHaveBeenCalledWith({
            provider: "github",
            serverUrl: provider.serverUrl,
            token: "access-token-secret",
        });
        expect(result.credentials).toEqual({
            username: "x-access-token",
            password: "access-token-secret",
            oauthProviderId: "github",
        });
        expect(result.account).toEqual(account);
    });

    it("supports self-hosted Forgejo and persists refresh metadata", async () => {
        configure([
            { ...provider, provider: "forgejo", serverUrl: "https://git.example.com/forge" },
        ]);
        vi.mocked(gitProviderRequest).mockResolvedValue({
            access_token: "token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh",
        });
        const flow = start();
        expect(flow.url.pathname).toBe("/forge/login/oauth/authorize");
        expect(flow.url.searchParams.has("scope")).toBe(false);

        const { credentials } = await exchangeGitOAuthCode(
            readGitOAuthFlow(flow.cookie, flow.state, identity),
            "code",
        );

        expect(credentials.username).toBe(account.login);
        expect(credentials.refreshToken).toBe("refresh");
        expect(listGitRepositories).toHaveBeenCalledWith({
            provider: "forgejo",
            serverUrl: "https://git.example.com/forge",
            token: "token",
        });
        expect(Date.parse(credentials.expiresAt!)).toBeGreaterThan(Date.now() + 3_500_000);
        expect(gitProviderRequest).toHaveBeenCalledWith(
            "https://git.example.com/forge/login/oauth/access_token",
            expect.anything(),
        );
    });

    it.each([
        {},
        { access_token: "token", token_type: "mac" },
        { access_token: "token", token_type: "bearer", expires_in: 3600 },
        { access_token: "token", token_type: "bearer", expires_in: -1, refresh_token: "refresh" },
        { access_token: "token", token_type: "bearer", expires_in: 60, refresh_token: "refresh" },
        {
            access_token: "token",
            token_type: "bearer",
            expires_in: "3600",
            refresh_token: "refresh",
        },
        {
            access_token: "token",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "refresh",
            refresh_token_expires_in: 1,
        },
        { access_token: "token", token_type: "bearer", error: "secret provider message" },
    ])("rejects unusable token responses", async (response) => {
        vi.mocked(gitProviderRequest).mockResolvedValue(response);
        const flow = start();
        await expect(
            exchangeGitOAuthCode(readGitOAuthFlow(flow.cookie, flow.state, identity), "code"),
        ).rejects.toThrow("invalid_token");
        expect(getGitAccount).not.toHaveBeenCalled();
    });

    it("sanitizes transport, identity and repository-access failures", async () => {
        const flow = start();
        const state = readGitOAuthFlow(flow.cookie, flow.state, identity);
        vi.mocked(gitProviderRequest).mockRejectedValueOnce(new Error("token and client-secret"));
        await expect(exchangeGitOAuthCode(state, "code")).rejects.toThrow("token_exchange_failed");
        vi.mocked(getGitAccount).mockRejectedValueOnce(new Error("token and account details"));
        await expect(exchangeGitOAuthCode(state, "code")).rejects.toThrow("account_failed");
        expect(listGitRepositories).not.toHaveBeenCalled();
        vi.mocked(listGitRepositories).mockRejectedValueOnce(
            new Error("token and repository details"),
        );
        await expect(exchangeGitOAuthCode(state, "code")).rejects.toThrow("account_failed");
    });

    it("refreshes only within 60 seconds and returns rotated credentials without mutating input", async () => {
        vi.useFakeTimers();

        const credentials: GitCredentials = {
            username: "x-access-token",
            password: "old-token",
            oauthProviderId: "github",
            refreshToken: "old-refresh",
            expiresAt: new Date(Date.now() + 61_000).toISOString(),
        };

        expect(await refreshGitOAuthCredentials(credentials)).toBe(credentials);
        expect(gitProviderRequest).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        vi.mocked(gitProviderRequest).mockResolvedValue({
            access_token: "new-token",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "new-refresh",
        });
        const replacement = await refreshGitOAuthCredentials(credentials);
        expect(replacement).toMatchObject({
            username: credentials.username,
            password: "new-token",
            refreshToken: "new-refresh",
            oauthProviderId: "github",
        });
        expect(
            new URLSearchParams(vi.mocked(gitProviderRequest).mock.calls[0]![1]?.body).get(
                "refresh_token",
            ),
        ).toBe("old-refresh");
        expect(credentials.password).toBe("old-token");
        expect(credentials.refreshToken).toBe("old-refresh");
    });

    it("leaves PAT/nonexpiring GitHub credentials unchanged and rejects missing refresh metadata", async () => {
        for (const credentials of [
            { password: "pat" },
            { password: "oauth", oauthProviderId: "github" },
        ]) {
            expect(await refreshGitOAuthCredentials(credentials)).toBe(credentials);
        }

        await expect(
            refreshGitOAuthCredentials({ oauthProviderId: "github", expiresAt: "invalid" }),
        ).rejects.toThrow("invalid_token");
        await expect(
            refreshGitOAuthCredentials({
                oauthProviderId: "github",
                expiresAt: new Date(0).toISOString(),
            }),
        ).rejects.toThrow("invalid_token");
        await expect(refreshGitOAuthCredentials({ oauthProviderId: "removed" })).rejects.toThrow(
            "GIT_OAUTH_PROVIDERS",
        );
        configure([{ ...provider, provider: "forgejo" }]);
        await expect(refreshGitOAuthCredentials({ oauthProviderId: "github" })).rejects.toThrow(
            "invalid_token",
        );
    });
});

describe("Git OAuth endpoints", () => {
    it.each([
        ["http://localhost:5173", "stoat-git-oauth", false],
        ["http://127.0.0.1:5173", "stoat-git-oauth", false],
        ["http://[::1]:5173", "stoat-git-oauth", false],
        ["https://localhost:5173", "__Host-stoat-git-oauth", true],
        ["https://stoat.example.com", "__Host-stoat-git-oauth", true],
    ] as const)(
        "uses consistent cookies for start, callback and denial at %s",
        async (baseUrl, name, secure) => {
            vi.stubEnv("BETTER_AUTH_URL", baseUrl);
            const options = { path: "/", httpOnly: true, sameSite: "lax", maxAge: 600, secure };
            expect(getGitOAuthCookieConfig()).toEqual({ name, options });
            const url = `${baseUrl}/git/oauth/start`;

            const input = event(
                url,
                new Request(url, {
                    method: "POST",
                    headers: {
                        origin: baseUrl,
                        "x-forwarded-proto": "http",
                        "x-forwarded-host": "localhost:5173",
                    },
                    body: new URLSearchParams({
                        organizationId: identity.organizationId,
                        providerId: "github",
                        name: "Work",
                    }),
                }),
            );

            const response = await POST(input);
            expect(input.cookies.set).toHaveBeenCalledWith(name, expect.any(String), options);
            const authorization = new URL(response.headers.get("location")!);
            expect(authorization.searchParams.get("redirect_uri")).toBe(
                `${baseUrl}/git/oauth/callback`,
            );
            const state = authorization.searchParams.get("state");
            const cookie = input.cookies.set.mock.calls[0]![1];

            for (const denied of [false, true]) {
                const callback = event(
                    `${baseUrl}/git/oauth/callback?state=${state}&${denied ? "error=access_denied" : "code=code"}`,
                );

                callback.cookies.get.mockImplementation((requestedName: string) =>
                    requestedName === name ? cookie : undefined,
                );
                const result = await GET(callback);
                expect(result.headers.get("location")).toBe(
                    `/git?oauth=${denied ? "invalid_request" : "success"}`,
                );
                expect(callback.cookies.get).toHaveBeenCalledExactlyOnceWith(name);
                expect(callback.cookies.delete).toHaveBeenCalledExactlyOnceWith(name, options);
            }

            expect(mocks.insert).toHaveBeenCalledTimes(1);
        },
    );

    it("never reads the local cookie as a fallback on HTTPS", async () => {
        const flow = start();
        const input = event(`${getGitOAuthCallbackUrl()}?state=${flow.state}&code=code`);
        input.cookies.get.mockImplementation((name: string) =>
            name === "stoat-git-oauth" ? flow.cookie : undefined,
        );
        const response = await GET(input);
        expect(response.headers.get("location")).toBe("/git?oauth=invalid_state");
        expect(input.cookies.get).toHaveBeenCalledExactlyOnceWith(gitOAuthCookieName);
        expect(input.cookies.delete).toHaveBeenCalledExactlyOnceWith(
            gitOAuthCookieName,
            gitOAuthCookieOptions,
        );
        expect(gitProviderRequest).not.toHaveBeenCalled();
    });

    it("clears the secure cookie and returns a safe error when app configuration is invalid", async () => {
        vi.stubEnv("BETTER_AUTH_URL", "http://stoat.example.com");
        const input = event("https://stoat.example.com/git/oauth/callback?code=secret-code");
        const response = await GET(input);
        expect(response.headers.get("location")).toBe("/git?oauth=configuration");
        expect(input.cookies.get).not.toHaveBeenCalled();
        expect(input.cookies.delete).toHaveBeenCalledExactlyOnceWith(
            gitOAuthCookieName,
            gitOAuthCookieOptions,
        );
        expect(gitProviderRequest).not.toHaveBeenCalled();
    });

    it("accepts a same-origin ordinary form and sets only an encrypted secure cookie", async () => {
        const url = "https://stoat.example.com/git/oauth/start";

        const input = event(
            url,
            new Request(url, {
                method: "POST",
                headers: { origin: "https://stoat.example.com" },
                body: new URLSearchParams({
                    organizationId: identity.organizationId,
                    providerId: "github",
                    name: "Work",
                }),
            }),
        );

        const response = await POST(input);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toMatch(
            /^https:\/\/github.com\/login\/oauth\/authorize\?/,
        );
        expect(input.cookies.set).toHaveBeenCalledWith(
            gitOAuthCookieName,
            expect.any(String),
            gitOAuthCookieOptions,
        );
        expect(mocks.session).toHaveBeenCalledWith(
            expect.objectContaining({ query: { disableCookieCache: true } }),
        );
    });

    it.each<Record<string, string>>([
        { providerId: "github", name: "" },
        { providerId: "github", name: "Work", redirect_uri: "https://attacker.example" },
        { providerId: "github", name: "Work", connectionId: "not-a-uuid" },
    ])("rejects invalid start input without setting a cookie", async (form) => {
        const url = "https://stoat.example.com/git/oauth/start";

        const input = event(
            url,
            new Request(url, {
                method: "POST",
                headers: { origin: "https://stoat.example.com" },
                body: new URLSearchParams({ organizationId: identity.organizationId, ...form }),
            }),
        );

        const response = await POST(input);
        expect(response.headers.get("location")).toBe("/git?oauth=invalid_request");
        expect(input.cookies.set).not.toHaveBeenCalled();
    });

    it.each([undefined, "", "org-1"])(
        "rejects missing or stale form organization %s before provider lookup",
        async (organizationId) => {
            mocks.session.mockResolvedValue({
                ...session,
                session: { ...session!.session, activeOrganizationId: "org-2" },
            });
            const url = "https://stoat.example.com/git/oauth/start";

            const form = new URLSearchParams({ providerId: "github", name: "Work" });

            if (organizationId !== undefined) form.set("organizationId", organizationId);

            const input = event(
                url,
                new Request(url, {
                    method: "POST",
                    headers: { origin: "https://stoat.example.com" },
                    body: form,
                }),
            );

            const response = await POST(input);
            expect(response.headers.get("location")).toBe(
                `/git?oauth=${organizationId ? "forbidden" : "invalid_request"}`,
            );
            expect(mocks.db.select).not.toHaveBeenCalled();
            expect(input.cookies.set).not.toHaveBeenCalled();
            expect(gitProviderRequest).not.toHaveBeenCalled();
        },
    );

    it("rejects cross-origin starts before consulting auth", async () => {
        const url = "https://stoat.example.com/git/oauth/start";

        const input = event(
            url,
            new Request(url, { method: "POST", headers: { origin: "https://evil.example" } }),
        );

        expect((await POST(input)).headers.get("location")).toBe("/git?oauth=forbidden");
        expect(mocks.session).not.toHaveBeenCalled();
    });

    it.each([
        `organizationId=${identity.organizationId}&providerId=github&providerId=github&name=Work`,
        `organizationId=${identity.organizationId}&organizationId=${identity.organizationId}&providerId=github&name=Work`,
        `organizationId=${identity.organizationId}&providerId=github&name=${"x".repeat(8192)}`,
    ])("rejects duplicate or oversized form fields", async (body) => {
        const url = "https://stoat.example.com/git/oauth/start";

        const input = event(
            url,
            new Request(url, {
                method: "POST",
                headers: {
                    origin: "https://stoat.example.com",
                    "content-type": "application/x-www-form-urlencoded",
                },
                body,
            }),
        );

        expect((await POST(input)).headers.get("location")).toBe("/git?oauth=invalid_request");
        expect(input.cookies.set).not.toHaveBeenCalled();
    });

    it("does not exchange codes for implicit HEAD requests", async () => {
        const flow = start();
        const url = `${getGitOAuthCallbackUrl()}?state=${flow.state}&code=code`;
        const input = event(url, new Request(url, { method: "HEAD" }), flow.cookie);
        expect((await GET(input)).headers.get("location")).toBe("/git?oauth=invalid_request");
        expect(gitProviderRequest).not.toHaveBeenCalled();
        expect(input.cookies.delete).toHaveBeenCalled();
    });

    it("creates an OAuth account with encrypted credentials and no repository columns", async () => {
        const flow = start();

        const input = event(
            `${getGitOAuthCallbackUrl()}?state=${flow.state}&code=code`,
            undefined,
            flow.cookie,
        );

        const response = await GET(input);
        expect(response.headers.get("location")).toBe("/git?oauth=success");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        const saved = mocks.insert.mock.calls[0]![0];
        expect(saved).toMatchObject({
            organizationId: identity.organizationId,
            authType: "oauth",
            account,
            repositories: [],
        });
        expect(saved).not.toHaveProperty("url");
        expect(saved).not.toHaveProperty("branch");
        expect(
            decryptGitCredentials(saved.encryptedCredentials, {
                organizationId: identity.organizationId,
                connectionId: saved.id,
            }),
        ).toMatchObject({ password: "access-token-secret", oauthProviderId: "github" });
        expect(input.cookies.delete).toHaveBeenCalledWith(
            gitOAuthCookieName,
            gitOAuthCookieOptions,
        );
    });

    it("updates matching connections in place without replacing repository or resource bindings", async () => {
        const connectionId = randomUUID();
        mocks.connection = {
            id: connectionId,
            organizationId: identity.organizationId,
            provider: provider.provider,
            serverUrl: provider.serverUrl,
            name: "Original",
        };

        const flow = createGitOAuthFlow({
            ...identity,
            providerId: "github",
            name: "Updated",
            connectionId,
        });

        const state = new URL(flow.authorizationUrl).searchParams.get("state");

        const input = event(
            `${getGitOAuthCallbackUrl()}?state=${state}&code=code`,
            undefined,
            flow.cookie,
        );

        expect((await GET(input)).headers.get("location")).toBe("/git?oauth=success");
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(mocks.update).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Updated", account }),
        );
        expect(mocks.update.mock.calls[0]![0]).not.toHaveProperty("repositories");
    });

    it.each([
        "missing-cookie",
        "denied",
        "wrong-state",
        "wrong-session",
        "revoked-during-exchange",
        "demoted-during-write",
        "provider-failure",
        "repository-failure",
    ])("clears the cookie and never saves on %s", async (failure) => {
        const flow = start();

        if (failure === "wrong-session")
            mocks.session.mockResolvedValue({
                ...session,
                session: { ...session!.session, id: "other" },
            });

        if (failure === "revoked-during-exchange")
            mocks.session.mockResolvedValueOnce(session).mockResolvedValueOnce(null);

        if (failure === "demoted-during-write") mocks.lockedRole = "member";

        if (failure === "provider-failure")
            vi.mocked(gitProviderRequest).mockRejectedValue(new Error("secret-token code"));

        if (failure === "repository-failure")
            vi.mocked(listGitRepositories).mockRejectedValue(
                new Error("secret-token repository access denied"),
            );

        const input = event(
            `${getGitOAuthCallbackUrl()}?state=${failure === "wrong-state" ? "x".repeat(43) : flow.state}&code=code${failure === "denied" ? "&error=secret-token" : ""}`,
            undefined,
            failure === "missing-cookie" ? undefined : flow.cookie,
        );

        const response = await GET(input);

        const expected =
            failure === "denied"
                ? "invalid_request"
                : ["revoked-during-exchange", "demoted-during-write"].includes(failure)
                  ? "forbidden"
                  : failure === "provider-failure"
                    ? "token_exchange_failed"
                    : failure === "repository-failure"
                      ? "account_failed"
                      : "invalid_state";

        expect(response.headers.get("location")).toBe(`/git?oauth=${expected}`);
        expect(response.headers.get("location")).not.toContain("secret-token");
        expect(input.cookies.delete).toHaveBeenCalledWith(
            gitOAuthCookieName,
            gitOAuthCookieOptions,
        );
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
    });
});
