import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { gitConnections, gitOAuthProviders, member, organization } from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Context } from "../../packages/api/src/context";
import {
    createGitOAuthFlow,
    createOrganizationGitOAuthProvider,
    getOrganizationGitOAuthProviders,
    readGitOAuthFlow,
} from "../../packages/api/src/git-oauth";
import {
    decryptGitOAuthClientSecret,
    encryptGitOAuthClientSecret,
} from "../../packages/api/src/git-oauth-secrets";
import { gitProviderRequest } from "../../packages/api/src/git-provider";
import { decryptGitCredentials, encryptGitCredentials } from "../../packages/api/src/git-secrets";
import { connectionsRouter, getGitConnection } from "../../packages/api/src/routers/connections";
import { POST } from "../../apps/web/src/routes/git/oauth/start/+server";
import { GET } from "../../apps/web/src/routes/git/oauth/callback/+server";

type TestServices = { db: Context["db"] | null; session: Context["session"] };

const services = vi.hoisted(() => {
    const state: TestServices = { db: null, session: null };

    return state;
});

vi.mock("../../apps/web/src/services", () => ({
    getDb: () => services.db,
    getAuth: () => ({ api: { getSession: async () => services.session } }),
}));

vi.mock("../../packages/api/src/git-provider", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../packages/api/src/git-provider")>()),
    gitProviderRequest: vi.fn(),
    getGitAccount: vi.fn(async () => ({ id: "42", login: "octocat", name: "Octocat" })),
    listGitRepositories: vi.fn(async ({ serverUrl }: { serverUrl: string }) => ({
        repositories: [
            { url: `${serverUrl}/team/app.git`, name: "team/app", defaultBranch: "main" },
        ],
        truncated: false,
    })),
}));

const input = {
    name: "Work Forge",
    provider: "forgejo" as const,
    serverUrl: "https://git.example.com/forge",
    clientId: "app-client-id",
    clientSecret: "app-client-secret-never-return",
};

const scope = { ...input, organizationId: "org-1", id: `db_${randomUUID()}` };

const globalApp = { ...input, id: "env-forge", name: "Global Forge" };

describe("Git OAuth app secret boundaries", () => {
    beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", "oauth-app-test-secret-at-least-32-bytes"));
    afterEach(() => vi.unstubAllEnvs());

    it("encrypts with random nonces and a domain distinct from account credentials", () => {
        const encrypted = encryptGitOAuthClientSecret(input.clientSecret, scope);
        expect(encrypted).not.toContain(input.clientSecret);
        expect(encryptGitOAuthClientSecret(input.clientSecret, scope)).not.toBe(encrypted);
        expect(decryptGitOAuthClientSecret(encrypted, scope)).toBe(input.clientSecret);

        const credentials = encryptGitCredentials(
            { password: input.clientSecret },
            {
                organizationId: scope.organizationId,
                connectionId: scope.id,
            },
        );

        expect(() => decryptGitOAuthClientSecret(credentials, scope)).toThrow("Unable to decrypt");
        expect(() =>
            decryptGitCredentials(encrypted, {
                organizationId: scope.organizationId,
                connectionId: scope.id,
            }),
        ).toThrow("Unable to decrypt");
    });

    it.each(["organizationId", "id", "provider", "serverUrl", "clientId"])(
        "binds encryption to %s",
        (field) => {
            const encrypted = encryptGitOAuthClientSecret(input.clientSecret, scope);
            expect(() =>
                decryptGitOAuthClientSecret(encrypted, { ...scope, [field]: "changed" }),
            ).toThrow("Unable to decrypt");
        },
    );

    it("rejects tampering and wrong keys without leaking payloads or causes", () => {
        const encrypted = encryptGitOAuthClientSecret(input.clientSecret, scope);

        for (const envelope of [
            encrypted.slice(0, -4),
            `v2${encrypted.slice(2)}`,
            "invalid",
            "x".repeat(65537),
        ]) {
            expect(() => decryptGitOAuthClientSecret(envelope, scope)).toThrow("Unable to decrypt");
        }

        vi.stubEnv("BETTER_AUTH_SECRET", "another-test-secret-at-least-32-bytes");
        expect(() => decryptGitOAuthClientSecret(encrypted, scope)).toThrow("Unable to decrypt");
        vi.stubEnv("BETTER_AUTH_SECRET", "short");
        expect(() => encryptGitOAuthClientSecret(input.clientSecret, scope)).toThrow(
            "Unable to encrypt",
        );
    });

    it("sanitizes validation input and database exceptions, including their causes", async () => {
        // SAFETY: this failure-path test exercises only the select and transaction stubs.
        const db = {
            select: () => ({
                from: () => ({ where: () => ({ limit: async () => [{ role: "owner" }] }) }),
            }),
            transaction: vi
                .fn()
                .mockRejectedValue(new Error(`SQL parameters: ${input.clientSecret}`)),
        } as Context["db"];

        // SAFETY: authorization only reads these user and active-organization identifiers.
        const context = {
            db,
            session: { user: { id: "user" }, session: { activeOrganizationId: "org" } },
        } as Context;

        for (const invalid of [
            { ...input, name: "" },
            { ...input, clientSecret: "x".repeat(8193) },
            input,
        ]) {
            const error = await call(
                connectionsRouter.createOAuthProvider,
                { ...invalid, organizationId: "org" },
                {
                    context,
                },
            ).catch((cause: unknown) => cause);

            expect(error).toMatchObject({
                code: invalid === input ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST",
            });
            expect(error).not.toHaveProperty("cause", expect.anything());
            expect(inspect(error, { depth: null })).not.toContain(input.clientSecret);
            expect(inspect(error, { depth: null })).not.toContain("SQL parameters");
        }
    });

    it.each([undefined, "", "stale-org"])(
        "rejects missing or stale setup organization %s before writing",
        async (organizationId) => {
            const transaction = vi.fn();

            // SAFETY: rejected requests only read this identity and membership query fixture.
            const context = {
                db: {
                    select: () => ({
                        from: () => ({ where: () => ({ limit: async () => [{ role: "owner" }] }) }),
                    }),
                    transaction,
                },
                session: { user: { id: "user" }, session: { activeOrganizationId: "org" } },
            } as Context;

            await expect(
                call(
                    connectionsRouter.createOAuthProvider,
                    { ...input, organizationId: organizationId! },
                    { context },
                ),
            ).rejects.toMatchObject({ code: organizationId ? "FORBIDDEN" : "BAD_REQUEST" });
            expect(transaction).not.toHaveBeenCalled();
        },
    );
});

// Only the uniquely named disposable database is migrated. DATABASE_URL is an admin connection.
describe("Organization OAuth apps (PostgreSQL)", () => {
    const databaseName = `stoat_oauth_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let databaseCreated = false;
    let ownerContext: Context;
    let adminContext: Context;
    let memberContext: Context;
    let foreignContext: Context;
    const orgId = (context: Context) => context.session!.session.activeOrganizationId!;

    const identity = (context: Context) => ({
        userId: context.session!.user.id,
        sessionId: context.session!.session.id,
        organizationId: orgId(context),
    });

    beforeAll(async () => {
        if (!process.env.DATABASE_URL)
            throw new Error("Testcontainers setup must provide DATABASE_URL");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        services.db = db;
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        const contexts: Context[] = [];
        let organizationId: string;

        for (const role of ["owner", "admin", "member", "foreign"]) {
            const userId = randomUUID();
            await db.$client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
                userId,
                role,
                `${role}@example.test`,
            ]);

            const [membership] = await db.select().from(member).where(eq(member.userId, userId));

            if (role === "owner") organizationId = membership!.organizationId;

            const activeOrganizationId =
                role === "foreign" ? membership!.organizationId : organizationId!;

            if (role === "admin" || role === "member") {
                await db.insert(member).values({
                    id: randomUUID(),
                    organizationId: activeOrganizationId,
                    userId,
                    role,
                    createdAt: new Date(),
                });
            }

            // SAFETY: router authorization only reads identity and active organization.
            contexts.push({
                db,
                session: {
                    user: { id: userId, name: role, email: `${role}@example.test` },
                    session: { id: randomUUID(), activeOrganizationId },
                },
            } as Context);
        }

        // SAFETY: the loop above creates exactly these four roles in this order.
        [ownerContext, adminContext, memberContext, foreignContext] = contexts as [
            Context,
            Context,
            Context,
            Context,
        ];
    }, 30_000);

    beforeEach(async () => {
        vi.stubEnv("BETTER_AUTH_SECRET", "oauth-app-test-secret-at-least-32-bytes");
        vi.stubEnv("BETTER_AUTH_URL", "https://stoat.example.com");
        vi.stubEnv("GIT_OAUTH_PROVIDERS", JSON.stringify([globalApp]));
        await db.delete(gitConnections);
        await db.delete(gitOAuthProviders);
        services.session = ownerContext.session;
        vi.mocked(gitProviderRequest).mockReset().mockResolvedValue({
            access_token: "access-token",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "refresh-token",
        });
    });

    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            try {
                if (databaseCreated) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
            } finally {
                await admin.$client.end();
            }
        }
    });

    async function register(context = ownerContext, configuration = input) {
        return call(
            connectionsRouter.createOAuthProvider,
            { ...configuration, organizationId: orgId(context) },
            { context },
        );
    }

    async function start(
        providerId: string,
        context = ownerContext,
        connectionId?: string,
        organizationId = orgId(context),
    ) {
        services.session = context.session;
        const cookies = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
        const url = "https://stoat.example.com/git/oauth/start";
        const form = new URLSearchParams({ organizationId, providerId, name: "Work" });

        if (connectionId) form.set("connectionId", connectionId);

        // SAFETY: POST reads request and cookies only, not framework-internal event fields.
        const response = await POST({
            url: new URL(url),
            request: new Request(url, {
                method: "POST",
                headers: { origin: "https://stoat.example.com" },
                body: form,
            }),
            cookies,
        } as Parameters<typeof POST>[0]);

        return { response, cookies };
    }

    async function callback(started: Awaited<ReturnType<typeof start>>) {
        const authorization = new URL(started.response.headers.get("location")!);

        const url = new URL(
            `https://stoat.example.com/git/oauth/callback?code=code&state=${authorization.searchParams.get("state")}`,
        );

        // SAFETY: GET reads only request, url and these cookie methods.
        return GET({
            request: new Request(url),
            url,
            cookies: {
                get: () => started.cookies.set.mock.calls[0]![1],
                delete: vi.fn(),
            },
        } as Parameters<typeof GET>[0]);
    }

    it("allows only current org owners/admins to configure apps and returns the exact callback", async () => {
        for (const context of [ownerContext, adminContext]) {
            await expect(
                call(connectionsRouter.oauthSetup, undefined, { context }),
            ).resolves.toEqual({ callbackUrl: "https://stoat.example.com/git/oauth/callback" });
            expect((await register(context)).id).toMatch(/^db_[a-f0-9-]{36}$/);
        }

        for (const context of [
            memberContext,
            { ...ownerContext, session: null },
            {
                ...ownerContext,
                session: {
                    ...ownerContext.session!,
                    session: {
                        ...ownerContext.session!.session,
                        activeOrganizationId: orgId(foreignContext),
                    },
                },
            },
        ]) {
            for (const [procedure, value] of [
                [connectionsRouter.oauthSetup, undefined],
                [
                    connectionsRouter.createOAuthProvider,
                    { ...input, organizationId: orgId(ownerContext) },
                ],
            ] as const) {
                // SAFETY: each procedure remains paired with its matching input in the tuple above.
                await expect(
                    call(procedure as typeof connectionsRouter.createOAuthProvider, value!, {
                        context,
                    }),
                ).rejects.toMatchObject({
                    code: context.session ? "FORBIDDEN" : "UNAUTHORIZED",
                });
            }
        }

        // Defense in depth: the write checks the live role under a transaction lock.
        await expect(
            createOrganizationGitOAuthProvider(db, identity(memberContext), input),
        ).rejects.toMatchObject({ code: "forbidden" });
        expect(await db.select().from(gitOAuthProviders)).toHaveLength(2);
    });

    it("rejects a dialog opened in org A after the same admin switches to org B", async () => {
        const opened = await call(connectionsRouter.list, undefined, { context: ownerContext });
        const membershipId = randomUUID();
        await db.insert(member).values({
            id: membershipId,
            organizationId: orgId(foreignContext),
            userId: ownerContext.session!.user.id,
            role: "admin",
            createdAt: new Date(),
        });

        try {
            const switched = {
                ...ownerContext,
                session: {
                    ...ownerContext.session!,
                    session: {
                        ...ownerContext.session!.session,
                        activeOrganizationId: orgId(foreignContext),
                    },
                },
            };

            const current = await call(connectionsRouter.list, undefined, {
                context: switched,
            });

            expect(current.organizationId).not.toBe(opened.organizationId);
            await expect(
                call(
                    connectionsRouter.createOAuthProvider,
                    {
                        ...input,
                        organizationId: opened.organizationId,
                    },
                    { context: switched },
                ),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });

            const started = await start(globalApp.id, switched, undefined, opened.organizationId);

            expect(started.response.headers.get("location")).toBe("/git?oauth=forbidden");
            expect(started.cookies.set).not.toHaveBeenCalled();
            expect(await db.select().from(gitOAuthProviders)).toEqual([]);
            expect(await db.select().from(gitConnections)).toEqual([]);
            expect(gitProviderRequest).not.toHaveBeenCalled();
        } finally {
            await db.delete(member).where(eq(member.id, membershipId));
        }
    });

    it("encrypts secrets, lists only safe global + active org metadata, and creates replacements without mutation", async () => {
        const created = await register();

        const replacement = await register(adminContext, {
            ...input,
            clientId: "replacement",
            clientSecret: "replacement-secret",
        });

        const foreign = await register(foreignContext);
        const inactive = await register();
        await db
            .update(gitOAuthProviders)
            .set({ active: false })
            .where(eq(gitOAuthProviders.id, inactive.id));
        expect(replacement.id).not.toBe(created.id);
        expect(Object.keys(created).sort()).toEqual(["id", "name", "provider", "serverUrl"]);

        const [stored] = await db
            .select()
            .from(gitOAuthProviders)
            .where(eq(gitOAuthProviders.id, created.id));

        expect(stored!.encryptedClientSecret).not.toContain(input.clientSecret);
        expect(decryptGitOAuthClientSecret(stored!.encryptedClientSecret, stored!)).toBe(
            input.clientSecret,
        );

        for (const context of [ownerContext, memberContext, foreignContext]) {
            const listed = await call(connectionsRouter.list, undefined, { context });
            expect(listed.organizationId).toBe(orgId(context));
            expect(listed.oauthProviders.map((app) => app.id).sort()).toEqual(
                (context === foreignContext
                    ? [globalApp.id, foreign.id]
                    : [globalApp.id, created.id, replacement.id]
                ).sort(),
            );

            for (const app of listed.oauthProviders)
                expect(Object.keys(app).sort()).toEqual(["id", "name", "provider", "serverUrl"]);
            expect(JSON.stringify(listed)).not.toContain("client");
            expect(JSON.stringify(listed)).not.toContain(stored!.encryptedClientSecret);
        }

        const resolved = await getOrganizationGitOAuthProviders(db, orgId(ownerContext));
        expect(resolved.map((app) => app.id)).not.toContain(foreign.id);
        expect(resolved.map((app) => app.id)).not.toContain(inactive.id);
        expect(resolved.find((app) => app.id === created.id)?.clientSecret).toBe(
            input.clientSecret,
        );
        expect(process.env.GIT_OAUTH_PROVIDERS).toBe(JSON.stringify([globalApp]));
    });

    it.each([
        "http://git.example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://10.0.0.1",
        "https://secret@git.example.com",
        "https://git.example.com/../admin",
        "https://git.example.com?token=secret",
    ])("rejects unsafe server %s without persisting it", async (serverUrl) => {
        await expect(register(ownerContext, { ...input, serverUrl })).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
        expect(await db.select().from(gitOAuthProviders)).toEqual([]);
    });

    it.each(["github", "forgejo"] as const)(
        "authorizes and refreshes a stored %s app through connection/resource resolution",
        async (provider) => {
            const configuration = {
                ...input,
                provider,
                serverUrl: provider === "github" ? "https://github.com" : input.serverUrl,
            };

            const created = await call(
                connectionsRouter.createOAuthProvider,
                { ...configuration, organizationId: orgId(ownerContext) },
                {
                    context: ownerContext,
                },
            );

            const started = await start(created.id);
            const authorization = new URL(started.response.headers.get("location")!);
            expect(authorization.searchParams.get("client_id")).toBe(input.clientId);
            expect(authorization.searchParams.get("redirect_uri")).toBe(
                "https://stoat.example.com/git/oauth/callback",
            );
            expect((await callback(started)).headers.get("location")).toBe("/git?oauth=success");
            const [connection] = await db.select().from(gitConnections);

            const credentialScope = {
                organizationId: orgId(ownerContext),
                connectionId: connection!.id,
            };

            const credentials = decryptGitCredentials(
                connection!.encryptedCredentials!,
                credentialScope,
            );

            expect(credentials.oauthProviderId).toBe(created.id);
            expect(credentials.refreshToken).toBe("refresh-token");

            const exchange = new URLSearchParams(
                vi.mocked(gitProviderRequest).mock.calls[0]![1]?.body,
            );

            expect(exchange.get("client_secret")).toBe(input.clientSecret);
            expect(exchange.get("grant_type")).toBe("authorization_code");
            await db
                .update(gitConnections)
                .set({
                    encryptedCredentials: encryptGitCredentials(
                        { ...credentials, expiresAt: new Date(0).toISOString() },
                        credentialScope,
                    ),
                })
                .where(eq(gitConnections.id, connection!.id));
            vi.mocked(gitProviderRequest).mockResolvedValueOnce({
                access_token: "rotated-access",
                token_type: "bearer",
                expires_in: 3600,
                refresh_token: "rotated-refresh",
            });

            const repo = await getGitConnection(
                db,
                orgId(ownerContext),
                connection!.id,
                `${configuration.serverUrl}/team/app.git`,
                "main",
            );

            expect(repo.credentials.password).toBe("rotated-access");

            const refresh = new URLSearchParams(
                vi.mocked(gitProviderRequest).mock.calls[1]![1]?.body,
            );

            expect(refresh.get("grant_type")).toBe("refresh_token");
            expect(refresh.get("client_secret")).toBe(input.clientSecret);
            const [updated] = await db.select().from(gitConnections);
            expect(
                decryptGitCredentials(updated!.encryptedCredentials!, credentialScope).refreshToken,
            ).toBe("rotated-refresh");
            await expect(
                call(
                    connectionsRouter.getRepositories,
                    { connectionId: connection!.id },
                    { context: memberContext },
                ),
            ).resolves.toMatchObject({ truncated: false });
            expect(gitProviderRequest).toHaveBeenCalledTimes(2);
        },
    );

    it("rejects foreign app starts, forged org-local state, and foreign app IDs in account credentials", async () => {
        const created = await register(foreignContext);
        const started = await start(created.id);
        expect(started.response.headers.get("location")).toBe("/git?oauth=configuration");
        expect(started.cookies.set).not.toHaveBeenCalled();

        const foreignProviders = await getOrganizationGitOAuthProviders(db, orgId(foreignContext));

        const localProviders = await getOrganizationGitOAuthProviders(db, orgId(ownerContext));

        const forged = createGitOAuthFlow(
            { ...identity(ownerContext), providerId: created.id, name: "Forged" },
            foreignProviders,
        );

        const state = new URL(forged.authorizationUrl).searchParams.get("state");
        expect(() =>
            readGitOAuthFlow(forged.cookie, state, identity(ownerContext), localProviders),
        ).toThrow("invalid_state");

        const url = new URL(
            `https://stoat.example.com/git/oauth/callback?state=${state}&code=secret`,
        );

        // SAFETY: GET reads only request, url and these cookie methods.
        const response = await GET({
            request: new Request(url),
            url,
            cookies: { get: () => forged.cookie, delete: vi.fn() },
        } as Parameters<typeof GET>[0]);

        expect(response.headers.get("location")).toBe("/git?oauth=invalid_state");
        const connectionId = randomUUID();
        await db.insert(gitConnections).values({
            id: connectionId,
            organizationId: orgId(ownerContext),
            name: "Invalid",
            provider: input.provider,
            serverUrl: input.serverUrl,
            authType: "oauth",
            encryptedCredentials: encryptGitCredentials(
                {
                    password: "token",
                    oauthProviderId: created.id,
                    refreshToken: "refresh",
                    expiresAt: new Date(0).toISOString(),
                },
                { organizationId: orgId(ownerContext), connectionId },
            ),
        });
        await expect(
            call(connectionsRouter.getRepositories, { connectionId }, { context: ownerContext }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(
            getGitConnection(
                db,
                orgId(ownerContext),
                connectionId,
                `${input.serverUrl}/team/app.git`,
                "main",
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(gitProviderRequest).not.toHaveBeenCalled();
    });

    it("invalidates pending state when the stored app is disabled or its client binding changes", async () => {
        const created = await register();
        const started = await start(created.id);
        await db
            .update(gitOAuthProviders)
            .set({ active: false })
            .where(eq(gitOAuthProviders.id, created.id));
        expect((await callback(started)).headers.get("location")).toBe("/git?oauth=invalid_state");

        const changed = {
            ...input,
            clientId: "changed",
            id: created.id,
            organizationId: orgId(ownerContext),
        };

        await db
            .update(gitOAuthProviders)
            .set({
                active: true,
                clientId: changed.clientId,
                encryptedClientSecret: encryptGitOAuthClientSecret(input.clientSecret, changed),
            })
            .where(eq(gitOAuthProviders.id, created.id));
        expect((await callback(started)).headers.get("location")).toBe("/git?oauth=invalid_state");
        expect(gitProviderRequest).not.toHaveBeenCalled();
    });

    it("keeps env apps usable and reconnects their persisted connections to replacement org apps", async () => {
        expect((await callback(await start(globalApp.id))).headers.get("location")).toBe(
            "/git?oauth=success",
        );
        const [before] = await db.select().from(gitConnections);
        const replacement = await register(ownerContext, { ...input, clientId: "replacement" });
        expect(
            (await callback(await start(replacement.id, ownerContext, before!.id))).headers.get(
                "location",
            ),
        ).toBe("/git?oauth=success");
        const connections = await db.select().from(gitConnections);
        expect(connections).toHaveLength(1);
        expect(connections[0]!.id).toBe(before!.id);
        expect(
            decryptGitCredentials(connections[0]!.encryptedCredentials!, {
                organizationId: orgId(ownerContext),
                connectionId: before!.id,
            }).oauthProviderId,
        ).toBe(replacement.id);
        expect(
            (await getOrganizationGitOAuthProviders(db, orgId(foreignContext))).find(
                (app) => app.id === globalApp.id,
            ),
        ).toEqual(globalApp);
    });

    it("cascades org apps when the organization is removed", async () => {
        const id = randomUUID();
        await db
            .insert(organization)
            .values({ id, name: "Disposable", slug: id, createdAt: new Date() });
        await db.insert(gitOAuthProviders).values({
            ...scope,
            id: `db_${randomUUID()}`,
            organizationId: id,
            encryptedClientSecret: "unused",
        });
        await db.delete(organization).where(eq(organization.id, id));
        expect(
            await db
                .select()
                .from(gitOAuthProviders)
                .where(eq(gitOAuthProviders.organizationId, id)),
        ).toEqual([]);
    });
});
