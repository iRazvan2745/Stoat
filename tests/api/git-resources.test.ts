import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call, ORPCError } from "@orpc/server";
import { createDb } from "@stoat/db";
import * as schema from "@stoat/db/schema/index";
import {
    clusters,
    gitConnections,
    organization,
    projects,
    resources,
} from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Context } from "../../packages/api/src/context";
import {
    inspectGitRemote,
    listGitFiles,
    pushGitFile,
    readGitFile,
} from "../../packages/api/src/git";
import { getGitAccount, listGitRepositories } from "../../packages/api/src/git-provider";
import {
    getOrganizationGitOAuthProviders,
    refreshGitOAuthCredentials,
} from "../../packages/api/src/git-oauth";
import { decryptGitCredentials, encryptGitCredentials } from "../../packages/api/src/git-secrets";
import { connectionsRouter } from "../../packages/api/src/routers/connections";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import { resolveComposePath } from "../../packages/api/src/routers/resources/git";

// Keep validation, credential encryption, authorization, and database I/O real.
vi.mock("../../packages/api/src/git", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../packages/api/src/git")>()),
    inspectGitRemote: vi.fn(),
    listGitFiles: vi.fn(),
    readGitFile: vi.fn(),
    pushGitFile: vi.fn(),
}));

vi.mock("../../packages/api/src/git-provider", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../packages/api/src/git-provider")>()),
    getGitAccount: vi.fn(),
    listGitRepositories: vi.fn(),
}));

vi.mock("../../packages/api/src/git-oauth", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../packages/api/src/git-oauth")>()),
    getOrganizationGitOAuthProviders: vi.fn(),
    refreshGitOAuthCredentials: vi.fn(),
}));

const revision = "a".repeat(40);

const nextRevision = "b".repeat(40);

const rawSpec =
    '# Preserve this comment and quoting\nservices:\n  web:\n    image: "nginx:alpine"\n';

const draftSpec = rawSpec.replace("nginx:alpine", "nginx:stable");

const deployedSpec = rawSpec.replace("nginx:alpine", "nginx:1.27");

const credentials = { username: "git-test-user", password: "git-test-token-never-return" };

const repositoryUrl = "https://example.com/team/app.git";

const genericAccount = {
    provider: "generic" as const,
    serverUrl: "https://example.com",
    credentials,
    repositories: [{ url: repositoryUrl, name: "team/app", defaultBranch: "main" }],
};

describe("Compose Git directory resolution", () => {
    it.each(["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"])(
        "resolves root and nested directories containing %s",
        (filename) => {
            expect(resolveComposePath(".", [filename])).toBe(filename);
            expect(resolveComposePath("deploy", [`deploy/${filename}`])).toBe(`deploy/${filename}`);
            expect(resolveComposePath("deploy/", [`deploy/${filename}`])).toBe(
                `deploy/${filename}`,
            );
        },
    );

    it("prefers standard Compose filenames in order, but honors an explicit file", () => {
        const files = ["docker-compose.yaml", "docker-compose.yml", "compose.yml", "compose.yaml"];

        for (let i = files.length - 1; i >= 0; i--) {
            expect(resolveComposePath(".", files.slice(0, i + 1))).toBe(files[i]);
        }

        expect(resolveComposePath("docker-compose.yaml", files)).toBe("docker-compose.yaml");
        expect(resolveComposePath("custom.yaml", ["custom.yaml"])).toBe("custom.yaml");
    });

    it("does not search unrelated directories or fall back for a missing explicit file", () => {
        for (const path of [".", "deploy", "missing.yaml"]) {
            expect(() => resolveComposePath(path, ["other/compose.yaml"])).toThrow(
                expect.objectContaining({ code: "NOT_FOUND" }),
            );
        }
    });

    it.each(["../deploy", "/deploy", "deploy/../other", ".git", "deploy\\file"])(
        "rejects unsafe directory %s",
        (path) => {
            expect(() => resolveComposePath(path, [])).toThrow(
                expect.objectContaining({ code: "BAD_REQUEST" }),
            );
        },
    );
});

// Each suite gets its own database inside the shared test container.
describe("Git connections/resources (PostgreSQL)", () => {
    const databaseName = `stoat_git_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let databaseCreated = false;
    let ownerContext: Context;
    let adminContext: Context;
    let memberContext: Context;
    let foreignContext: Context;
    let organizationId: string;
    let foreignOrganizationId: string;
    let projectId: string;
    let resourceId: string;
    let connectionId: string;
    let foreignConnectionId: string;
    let foreignProjectId: string;
    let foreignResourceId: string;

    const inspect = vi.mocked(inspectGitRemote);
    const account = vi.mocked(getGitAccount);
    const discover = vi.mocked(listGitRepositories);
    const oauthProviders = vi.mocked(getOrganizationGitOAuthProviders);
    const refresh = vi.mocked(refreshGitOAuthCredentials);
    const list = vi.mocked(listGitFiles);
    const read = vi.mocked(readGitFile);
    const push = vi.mocked(pushGitFile);
    const source = () => ({ connectionId, repositoryUrl, branch: "release", path: "deploy/" });

    const expectedSource = () => ({
        connectionId,
        repositoryUrl,
        branch: "release",
        path: "deploy/compose.yaml",
        revision,
    });

    const target = () => ({
        projectId,
        resourceId,
        expectedSpec: rawSpec,
        expectedSource: expectedSource(),
    });

    const pushInput = () => ({
        ...target(),
        spec: draftSpec,
        expectedSpec: rawSpec,
        expectedRevision: revision,
        message: "Update Compose",
    });

    const storedResource = async () =>
        (await db.select().from(resources).where(eq(resources.id, resourceId)))[0]!;

    const storedConnection = async () =>
        (await db.select().from(gitConnections).where(eq(gitConnections.id, connectionId)))[0]!;

    function expectNoCredentials<T>(value: T, encrypted?: string | null, ...secrets: string[]) {
        const serialized = JSON.stringify(value);

        for (const secret of [
            credentials.username,
            credentials.password,
            "encryptedCredentials",
            '"credentials"',
            encrypted,
            ...secrets,
        ]) {
            if (secret) expect(serialized).not.toContain(secret);
        }
    }

    function expectNoGitIO() {
        expect(inspect).not.toHaveBeenCalled();
        expect(account).not.toHaveBeenCalled();
        expect(discover).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL)
            throw new Error("Testcontainers setup must provide DATABASE_URL");
        vi.stubEnv("BETTER_AUTH_SECRET", "git-integration-test-secret-at-least-32-bytes");
        vi.stubEnv("GIT_OAUTH_PROVIDERS", "[]");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = `/${databaseName}`;
        // A nested root-DB transaction must fail promptly, not hang or borrow a second client.
        db = drizzle({
            connection: {
                connectionString: url.toString(),
                max: 1,
                connectionTimeoutMillis: 2_000,
            },
            schema,
        });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const contexts: Context[] = [];

        for (const role of ["owner", "admin", "member", "foreign"]) {
            const userId = randomUUID();
            const email = `${role}@example.test`;
            await db.$client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
                userId,
                role,
                email,
            ]);

            const memberships = await db.$client.query(
                "SELECT organization_id FROM member WHERE user_id = $1",
                [userId],
            );

            const ownOrganizationId = memberships.rows[0].organization_id;

            if (role === "owner") organizationId = ownOrganizationId;

            if (role === "foreign") foreignOrganizationId = ownOrganizationId;

            const activeOrganizationId = role === "foreign" ? ownOrganizationId : organizationId;

            if (role === "admin" || role === "member") {
                await db.$client.query(
                    "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, now())",
                    [randomUUID(), organizationId, userId, role],
                );
            }

            // SAFETY: router authorization only reads the identity and active organization.
            contexts.push({
                db,
                session: {
                    user: { id: userId, name: role, email },
                    session: { activeOrganizationId },
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

    afterAll(async () => {
        vi.unstubAllEnvs();
        await db?.$client.end();

        if (admin) {
            try {
                if (databaseCreated) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
            } finally {
                await admin.$client.end();
            }
        }
    });

    beforeEach(async () => {
        inspect.mockReset().mockResolvedValue({ defaultBranch: "main" });
        account
            .mockReset()
            .mockResolvedValue({ id: "123", login: "test-account", name: "Test Account" });
        discover
            .mockReset()
            .mockResolvedValue({ repositories: genericAccount.repositories, truncated: false });
        oauthProviders.mockReset().mockResolvedValue([]);
        refresh.mockReset().mockImplementation(async (value) => value);
        list.mockReset().mockResolvedValue({ revision, files: ["deploy/compose.yaml"] });
        read.mockReset().mockImplementation(async (_repo, path) => ({
            revision,
            path,
            content: rawSpec,
        }));
        push.mockReset().mockResolvedValue({ revision: nextRevision });

        for (const context of [adminContext, foreignContext]) {
            const clusterId = randomUUID();
            const project = randomUUID();
            const resource = randomUUID();

            const connection = await call(
                connectionsRouter.create,
                {
                    name: "Repository",
                    ...genericAccount,
                },
                { context },
            );

            await db.insert(clusters).values({
                id: clusterId,
                name: "Git test",
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "unused",
                organizationId: context.session!.session.activeOrganizationId!,
            });
            await db.insert(projects).values({ id: project, clusterId, name: "Git test" });
            await db.insert(resources).values({
                id: resource,
                projectId: project,
                name: "Compose",
                type: "compose",
                draftSpec: rawSpec,
                spec: deployedSpec,
                settings: { env: "KEEP=value", prefixNames: false },
                gitConnectionId: connection.id,
                gitSource: {
                    repositoryUrl,
                    branch: "release",
                    path: "deploy/compose.yaml",
                    revision,
                },
            });

            if (context === adminContext) {
                projectId = project;
                resourceId = resource;
                connectionId = connection.id;
            } else {
                foreignProjectId = project;
                foreignResourceId = resource;
                foreignConnectionId = connection.id;
            }
        }

        vi.clearAllMocks();
    });

    it("lists only the active organization's connections with role flags and no credentials", async () => {
        const stored = await storedConnection();
        expect(stored.organizationId).toBe(organizationId);
        expect(stored.encryptedCredentials).toMatch(/^v1\./);
        expect(stored.encryptedCredentials).not.toContain(credentials.password);

        for (const context of [ownerContext, adminContext, memberContext]) {
            const result = await call(connectionsRouter.list, undefined, { context });
            expect(result.canManage).toBe(context !== memberContext);
            expect(result.connections.some((connection) => connection.id === connectionId)).toBe(
                true,
            );
            expect(
                result.connections.some((connection) => connection.id === foreignConnectionId),
            ).toBe(false);

            for (const connection of result.connections) {
                expect(connection).not.toHaveProperty("organizationId");
                expect(connection).not.toHaveProperty("url");
                expect(connection).not.toHaveProperty("branch");
            }

            expect(
                result.connections.find((connection) => connection.id === connectionId)
                    ?.hasCredentials,
            ).toBe(true);
            expectNoCredentials(result, stored.encryptedCredentials);
        }

        expectNoGitIO();
    });

    it("allows admin create/update, preserves omitted credentials, and explicitly clears them", async () => {
        const created = await call(
            connectionsRouter.create,
            { name: "New", ...genericAccount },
            { context: adminContext },
        );

        expect(created.hasCredentials).toBe(true);
        expectNoCredentials(created);
        const before = await storedConnection();

        const updated = await call(
            connectionsRouter.update,
            { connectionId, name: "Renamed" },
            { context: adminContext },
        );

        expect(updated).toMatchObject({
            name: "Renamed",
            provider: "generic",
            serverUrl: genericAccount.serverUrl,
            authType: "token",
            account: null,
            repositories: genericAccount.repositories,
            hasCredentials: true,
        });
        expect(inspect).toHaveBeenLastCalledWith({
            url: repositoryUrl,
            credentials,
        });
        const scope = { organizationId, connectionId };
        expect(
            decryptGitCredentials((await storedConnection()).encryptedCredentials!, scope),
        ).toEqual(decryptGitCredentials(before.encryptedCredentials!, scope));
        expectNoCredentials(updated, before.encryptedCredentials);

        const cleared = await call(
            connectionsRouter.update,
            { connectionId, name: "Public", credentials: {} },
            { context: ownerContext },
        );

        expect(cleared.hasCredentials).toBe(false);
        expect((await storedConnection()).encryptedCredentials).toBeNull();
        expect(inspect).toHaveBeenLastCalledWith({
            url: repositoryUrl,
            credentials: {},
        });
    });

    it("tests generic server access without writing and discovers the remote default branch on create/update", async () => {
        const before = await db.select().from(gitConnections);

        const input = {
            ...genericAccount,
            repositories: [{ ...genericAccount.repositories[0]!, defaultBranch: "old-default" }],
        };

        expect(
            await call(connectionsRouter.testConnection, input, { context: adminContext }),
        ).toEqual({ account: null, repositoryCount: 1, truncated: false });
        expect(
            await call(
                connectionsRouter.testConnection,
                { connectionId },
                { context: adminContext },
            ),
        ).toEqual({ account: null, repositoryCount: 1, truncated: false });
        expect(await db.select().from(gitConnections)).toEqual(before);

        const created = await call(
            connectionsRouter.create,
            { name: "Probe", ...input },
            { context: adminContext },
        );

        const updated = await call(
            connectionsRouter.update,
            {
                connectionId,
                name: "Probe",
                repositories: input.repositories,
            },
            { context: adminContext },
        );

        for (const result of [created, updated]) {
            expect(result.repositories).toEqual(genericAccount.repositories);
            expectNoCredentials(result);
        }

        expect(inspect).toHaveBeenCalledTimes(4);

        for (const args of inspect.mock.calls)
            expect(args).toEqual([{ url: repositoryUrl, credentials }]);
        expect(list).not.toHaveBeenCalled();
    });

    it.each([
        "https://rogue.example/team/app.git",
        "https://example.com:8443/team/app.git",
        "ssh://example.com/team/app.git",
        "https://example.com/team-other/app.git",
        "https://example.com/team/../other/app.git",
        "https://example.com/team/%2e%2e/other/app.git",
    ])("rejects a generic repository outside its server scope: %s", async (url) => {
        const before = await db.select().from(gitConnections);

        const input = {
            ...genericAccount,
            serverUrl: "https://example.com/team",
            repositories: [{ url, name: "team/app", defaultBranch: "main" }],
        };

        await expect(
            call(connectionsRouter.testConnection, input, { context: adminContext }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(
            call(connectionsRouter.create, { name: "Unsafe", ...input }, { context: adminContext }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await db.select().from(gitConnections)).toEqual(before);
        expectNoGitIO();
    });

    it.each([
        { kind: "missing", repositories: [] },
        {
            kind: "duplicate",
            repositories: [genericAccount.repositories[0]!, genericAccount.repositories[0]!],
        },
    ])("rejects $kind generic repositories", async ({ repositories }) => {
        await expect(
            call(
                connectionsRouter.create,
                {
                    ...genericAccount,
                    name: "Invalid",
                    repositories,
                },
                { context: adminContext },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expectNoGitIO();
    });

    it("accepts a generic server path prefix but not an unregistered repository on that server", async () => {
        const created = await call(
            connectionsRouter.create,
            {
                ...genericAccount,
                name: "Scoped",
                serverUrl: "https://example.com/team/",
            },
            { context: adminContext },
        );

        expect(created.serverUrl).toBe("https://example.com/team");
        expect(
            await call(
                connectionsRouter.getRepositories,
                { connectionId: created.id },
                { context: memberContext },
            ),
        ).toEqual({ repositories: genericAccount.repositories, truncated: false });
        vi.clearAllMocks();
        await expect(
            call(
                connectionsRouter.readFile,
                {
                    connectionId: created.id,
                    repositoryUrl: "https://example.com/team/unregistered.git",
                    branch: "main",
                    path: "compose.yaml",
                },
                { context: memberContext },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expectNoGitIO();
    });

    it.each([
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://example.com/team/../other",
        "https://example.com/team%2fother",
        "https://example.com?token=secret",
        "http://example.com",
    ])("validates generic server URL before probing: %s", async (serverUrl) => {
        await expect(
            call(
                connectionsRouter.testConnection,
                {
                    ...genericAccount,
                    serverUrl,
                },
                { context: adminContext },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expectNoGitIO();
    });

    describe.each(["github", "forgejo"] as const)("%s accounts", (provider) => {
        const serverUrl = provider === "github" ? "https://github.com" : "https://example.com/git";

        const repositories = [
            { url: `${serverUrl}/team/app.git`, name: "team/app", defaultBranch: "main" },
        ];

        const input = { provider, serverUrl, credentials: { password: credentials.password } };
        const identity = { id: "123", login: "test-account", name: "Test Account" };

        const gitCredentials = {
            password: credentials.password,
            username: provider === "github" ? "x-access-token" : identity.login,
        };

        beforeEach(() => {
            discover.mockResolvedValue({ repositories, truncated: false });
        });

        it.each([
            {},
            { username: "no-token" },
            { password: credentials.password, privateKey: "private-key" },
            { password: credentials.password, knownHosts: "known-hosts" },
        ])(
            "rejects missing tokens or SSH credentials before account API calls: %j",
            async (invalidCredentials) => {
                const before = await db.select().from(gitConnections);
                await expect(
                    call(
                        connectionsRouter.create,
                        {
                            ...input,
                            name: "Invalid",
                            credentials: invalidCredentials,
                        },
                        { context: adminContext },
                    ),
                ).rejects.toMatchObject({ code: "BAD_REQUEST" });
                expect(await db.select().from(gitConnections)).toEqual(before);
                expectNoGitIO();
            },
        );

        it.each([
            "https://127.0.0.1",
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/git/../other",
        ])(
            "validates provider server URLs before account API calls: %s",
            async (invalidServerUrl) => {
                await expect(
                    call(
                        connectionsRouter.testConnection,
                        {
                            ...input,
                            serverUrl: invalidServerUrl,
                        },
                        { context: adminContext },
                    ),
                ).rejects.toMatchObject({ code: "BAD_REQUEST" });
                expectNoGitIO();
            },
        );

        it("creates with only an account token, returns account metadata, and tests without writes", async () => {
            const before = await db.select().from(gitConnections);

            const result = await call(connectionsRouter.testConnection, input, {
                context: adminContext,
            });

            expect(result).toEqual({ account: identity, repositoryCount: 1, truncated: false });
            expect(await db.select().from(gitConnections)).toEqual(before);

            const created = await call(
                connectionsRouter.create,
                { name: "Account", ...input },
                { context: adminContext },
            );

            expect(created).toMatchObject({
                provider,
                serverUrl,
                authType: "token",
                account: identity,
                repositories: [],
                hasCredentials: true,
            });
            expect(created).not.toHaveProperty("url");
            expect(created).not.toHaveProperty("branch");

            const [stored] = await db
                .select()
                .from(gitConnections)
                .where(eq(gitConnections.id, created.id));

            expect(
                decryptGitCredentials(stored!.encryptedCredentials!, {
                    organizationId,
                    connectionId: created.id,
                }),
            ).toEqual(gitCredentials);

            const tested = await call(
                connectionsRouter.testConnection,
                { connectionId: created.id },
                { context: adminContext },
            );

            expect(tested).toEqual(result);
            expect(
                (
                    await db.select().from(gitConnections).where(eq(gitConnections.id, created.id))
                )[0],
            ).toEqual(stored);

            const listed = await call(connectionsRouter.list, undefined, {
                context: memberContext,
            });

            expect(listed.connections).toContainEqual(created);
            expectNoCredentials({ created, tested, listed }, stored!.encryptedCredentials);
            expect(account).toHaveBeenLastCalledWith({
                provider,
                serverUrl,
                token: credentials.password,
            });
            expect(discover).toHaveBeenLastCalledWith({
                provider,
                serverUrl,
                token: credentials.password,
            });
            expect(inspect).not.toHaveBeenCalled();
            expect(list).not.toHaveBeenCalled();
        });

        it("discovers current repositories per organization and uses the selected repository and branch", async () => {
            const own = await call(
                connectionsRouter.create,
                { name: "Own", ...input },
                { context: adminContext },
            );

            const foreignToken = "foreign-account-token-never-return";

            const foreign = await call(
                connectionsRouter.create,
                {
                    name: "Foreign",
                    ...input,
                    credentials: { password: foreignToken },
                },
                { context: foreignContext },
            );

            const foreignRepositories = [
                {
                    url: `${serverUrl}/foreign/private.git`,
                    name: "foreign/private",
                    defaultBranch: "production",
                },
            ];

            discover.mockImplementation(async ({ token }) => ({
                repositories: token === foreignToken ? foreignRepositories : repositories,
                truncated: false,
            }));
            vi.clearAllMocks();

            for (const [context, connection, expected, token] of [
                [memberContext, own, repositories, credentials.password],
                [foreignContext, foreign, foreignRepositories, foreignToken],
            ] as const) {
                const result = await call(
                    connectionsRouter.getRepositories,
                    { connectionId: connection.id },
                    { context },
                );

                expect(result).toEqual({ repositories: expected, truncated: false });
                expect(discover).toHaveBeenLastCalledWith({ provider, serverUrl, token });
                expectNoCredentials(result, null, foreignToken);
            }

            const selection = {
                connectionId: own.id,
                repositoryUrl: repositories[0]!.url,
                branch: "release",
            };

            await call(connectionsRouter.listFiles, selection, { context: memberContext });
            await call(
                connectionsRouter.readFile,
                { ...selection, path: "compose.yaml" },
                { context: memberContext },
            );
            await call(
                connectionsRouter.pushFile,
                {
                    ...selection,
                    path: "compose.yaml",
                    content: draftSpec,
                    expectedRevision: revision,
                    message: "Update",
                },
                { context: adminContext },
            );

            const repo = {
                url: selection.repositoryUrl,
                branch: "release",
                credentials: gitCredentials,
            };

            expect(list).toHaveBeenCalledExactlyOnceWith(repo);
            expect(read).toHaveBeenCalledExactlyOnceWith(repo, "compose.yaml");
            expect(push).toHaveBeenCalledExactlyOnceWith(
                repo,
                expect.objectContaining({ expectedRevision: revision }),
            );
            discover.mockResolvedValue({ repositories: [], truncated: false });
            read.mockClear();
            await expect(
                call(
                    connectionsRouter.readFile,
                    { ...selection, path: "compose.yaml" },
                    { context: memberContext },
                ),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(read).not.toHaveBeenCalled();
        });

        it("never sends the token to an unlisted or rogue repository URL", async () => {
            const created = await call(
                connectionsRouter.create,
                { name: "Account", ...input },
                { context: adminContext },
            );

            vi.clearAllMocks();

            for (const url of [
                "https://rogue.example/team/app.git",
                `${serverUrl}/private/unlisted.git`,
            ]) {
                const selection = {
                    connectionId: created.id,
                    repositoryUrl: url,
                    branch: "main",
                };

                const attempts = [
                    () =>
                        call(connectionsRouter.listFiles, selection, {
                            context: memberContext,
                        }),
                    () =>
                        call(
                            connectionsRouter.readFile,
                            { ...selection, path: "compose.yaml" },
                            { context: memberContext },
                        ),
                    () =>
                        call(
                            connectionsRouter.pushFile,
                            {
                                ...selection,
                                path: "compose.yaml",
                                content: rawSpec,
                                expectedRevision: revision,
                                message: "Unsafe",
                            },
                            { context: adminContext },
                        ),
                    () =>
                        call(
                            resourcesRouter.createResource,
                            { projectId, name: "Unsafe", git: { ...selection, path: "." } },
                            { context: memberContext },
                        ),
                    () =>
                        call(
                            resourcesRouter.setGitSource,
                            { ...target(), ...selection, path: "." },
                            { context: memberContext },
                        ),
                ];

                const before = await db.select().from(resources);

                for (const attempt of attempts) {
                    const error = await attempt().catch((cause: unknown) => cause);
                    expect(error).toMatchObject({ code: "NOT_FOUND" });
                    expectNoCredentials(error);
                }

                expect(await db.select().from(resources)).toEqual(before);
            }

            for (const args of discover.mock.calls)
                expect(args).toEqual([{ provider, serverUrl, token: credentials.password }]);
            expect(account).not.toHaveBeenCalled();
            expect(inspect).not.toHaveBeenCalled();
            expect(list).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
        });

        it("hides foreign accounts from all account and file operations before provider I/O", async () => {
            const created = await call(
                connectionsRouter.create,
                { name: "Foreign", ...input },
                { context: foreignContext },
            );

            const before = await db.select().from(gitConnections);
            vi.clearAllMocks();
            const context = adminContext;
            const id = { connectionId: created.id };
            const selection = { ...id, repositoryUrl: repositories[0]!.url, branch: "main" };

            const attempts = [
                () => call(connectionsRouter.testConnection, id, { context }),
                () => call(connectionsRouter.getRepositories, id, { context }),
                () => call(connectionsRouter.update, { ...id, name: "Forbidden" }, { context }),
                () => call(connectionsRouter.delete, id, { context }),
                () => call(connectionsRouter.listFiles, selection, { context }),
                () =>
                    call(
                        connectionsRouter.readFile,
                        { ...selection, path: "compose.yaml" },
                        { context },
                    ),
                () =>
                    call(
                        connectionsRouter.pushFile,
                        {
                            ...selection,
                            path: "compose.yaml",
                            content: rawSpec,
                            expectedRevision: revision,
                            message: "Forbidden",
                        },
                        { context },
                    ),
            ];

            for (const attempt of attempts)
                await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await db.select().from(gitConnections)).toEqual(before);
            expectNoGitIO();
        });

        it("keeps existing credentials when omitted and rolls back failed token verification", async () => {
            const created = await call(
                connectionsRouter.create,
                { name: "Account", ...input },
                { context: adminContext },
            );

            const scope = { organizationId, connectionId: created.id };

            const updated = await call(
                connectionsRouter.update,
                { connectionId: created.id, name: "Renamed" },
                { context: adminContext },
            );

            const [stored] = await db
                .select()
                .from(gitConnections)
                .where(eq(gitConnections.id, created.id));

            expect(decryptGitCredentials(stored!.encryptedCredentials!, scope)).toEqual(
                gitCredentials,
            );
            expectNoCredentials(updated, stored!.encryptedCredentials);
            account.mockRejectedValue(
                new ORPCError("BAD_GATEWAY", { message: "Account verification failed" }),
            );
            const before = await db.select().from(gitConnections);
            await expect(
                call(
                    connectionsRouter.create,
                    { name: "Failed", ...input },
                    { context: adminContext },
                ),
            ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
            await expect(
                call(
                    connectionsRouter.update,
                    {
                        connectionId: created.id,
                        name: "Failed",
                        credentials: { password: "replacement" },
                    },
                    { context: adminContext },
                ),
            ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
            expect(await db.select().from(gitConnections)).toEqual(before);
        });

        describe("OAuth refresh", () => {
            const configuration = {
                id: "test-oauth",
                name: "Test OAuth",
                provider,
                serverUrl,
                clientId: "client-id",
                clientSecret: "client-secret-never-return",
            };

            const oauthCredentials = {
                ...gitCredentials,
                oauthProviderId: configuration.id,
                refreshToken: "refresh-token-never-return",
                expiresAt: "2020-01-01T00:00:00.000Z",
            };

            const refreshed = {
                ...oauthCredentials,
                password: "refreshed-token-never-return",
                refreshToken: "rotated-refresh-token-never-return",
                expiresAt: "2099-01-01T00:00:00.000Z",
            };

            let oauthConnectionId: string;

            beforeEach(async () => {
                const created = await call(
                    connectionsRouter.create,
                    { name: "OAuth", ...input },
                    { context: adminContext },
                );

                oauthConnectionId = created.id;
                await db
                    .update(gitConnections)
                    .set({
                        authType: "oauth",
                        encryptedCredentials: encryptGitCredentials(oauthCredentials, {
                            organizationId,
                            connectionId: oauthConnectionId,
                        }),
                    })
                    .where(eq(gitConnections.id, oauthConnectionId));
                oauthProviders.mockResolvedValue([configuration]);
                refresh.mockResolvedValue(refreshed);
                vi.clearAllMocks();
            });

            it("refreshes only the matching configured account and persists scoped, encrypted credentials", async () => {
                const result = await call(
                    connectionsRouter.getRepositories,
                    { connectionId: oauthConnectionId },
                    { context: memberContext },
                );

                expect(refresh).toHaveBeenCalledExactlyOnceWith(oauthCredentials, [configuration]);
                expect(discover).toHaveBeenCalledExactlyOnceWith({
                    provider,
                    serverUrl,
                    token: refreshed.password,
                });

                const [stored] = await db
                    .select()
                    .from(gitConnections)
                    .where(eq(gitConnections.id, oauthConnectionId));

                expect(stored!.authType).toBe("oauth");
                expect(
                    decryptGitCredentials(stored!.encryptedCredentials!, {
                        organizationId,
                        connectionId: oauthConnectionId,
                    }),
                ).toEqual(refreshed);
                expect(() =>
                    decryptGitCredentials(stored!.encryptedCredentials!, {
                        organizationId: foreignOrganizationId,
                        connectionId: oauthConnectionId,
                    }),
                ).toThrow("Unable to decrypt Git credentials");

                const listed = await call(connectionsRouter.list, undefined, {
                    context: memberContext,
                });

                expectNoCredentials(
                    { result, listed },
                    stored!.encryptedCredentials,
                    configuration.clientSecret,
                    oauthCredentials.refreshToken,
                    refreshed.password,
                    refreshed.refreshToken,
                );
            });

            it("does not rewrite credentials when OAuth refresh returns the existing credentials", async () => {
                refresh.mockImplementation(async (value) => value);

                const [before] = await db
                    .select()
                    .from(gitConnections)
                    .where(eq(gitConnections.id, oauthConnectionId));

                await call(
                    connectionsRouter.getRepositories,
                    { connectionId: oauthConnectionId },
                    { context: memberContext },
                );
                expect(refresh).toHaveBeenCalledExactlyOnceWith(oauthCredentials, [configuration]);
                expect(discover).toHaveBeenCalledExactlyOnceWith({
                    provider,
                    serverUrl,
                    token: oauthCredentials.password,
                });
                expect(
                    (
                        await db
                            .select()
                            .from(gitConnections)
                            .where(eq(gitConnections.id, oauthConnectionId))
                    )[0],
                ).toEqual(before);
            });

            it("preserves credentials when the OAuth refresh itself fails", async () => {
                refresh.mockRejectedValueOnce(
                    new ORPCError("BAD_GATEWAY", { message: "Refresh failed" }),
                );

                const [before] = await db
                    .select()
                    .from(gitConnections)
                    .where(eq(gitConnections.id, oauthConnectionId));

                await expect(
                    call(
                        connectionsRouter.getRepositories,
                        { connectionId: oauthConnectionId },
                        { context: memberContext },
                    ),
                ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
                expect(
                    (
                        await db
                            .select()
                            .from(gitConnections)
                            .where(eq(gitConnections.id, oauthConnectionId))
                    )[0],
                ).toEqual(before);
                expect(discover).not.toHaveBeenCalled();
            });

            it("retains rotated OAuth credentials even when subsequent repository discovery fails", async () => {
                discover.mockRejectedValueOnce(
                    new ORPCError("BAD_GATEWAY", { message: "Discovery unavailable" }),
                );
                await expect(
                    call(
                        connectionsRouter.getRepositories,
                        { connectionId: oauthConnectionId },
                        { context: memberContext },
                    ),
                ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
                expect(refresh).toHaveBeenCalledExactlyOnceWith(oauthCredentials, [configuration]);

                const [stored] = await db
                    .select()
                    .from(gitConnections)
                    .where(eq(gitConnections.id, oauthConnectionId));

                // The provider has already rotated the refresh token; rolling it back loses access.
                expect(
                    decryptGitCredentials(stored!.encryptedCredentials!, {
                        organizationId,
                        connectionId: oauthConnectionId,
                    }),
                ).toEqual(refreshed);
            });

            describe.each(["create", "attach", "pull", "push"] as const)(
                "%s resource with a single-connection pool",
                (action) => {
                    const selection = () => ({
                        connectionId: oauthConnectionId,
                        repositoryUrl: repositories[0]!.url,
                        branch: "release",
                        path: "deploy/compose.yaml",
                    });

                    const snapshot = () => ({
                        ...target(),
                        expectedSource: { ...selection(), revision },
                    });

                    const storedAccount = async () =>
                        (
                            await db
                                .select()
                                .from(gitConnections)
                                .where(eq(gitConnections.id, oauthConnectionId))
                        )[0]!;

                    function operate(expected = snapshot()) {
                        const context = action === "push" ? adminContext : memberContext;

                        switch (action) {
                            case "create":
                                return call(
                                    resourcesRouter.createResource,
                                    {
                                        projectId,
                                        name: "OAuth import",
                                        git: selection(),
                                    },
                                    { context },
                                );
                            case "attach":
                                return call(
                                    resourcesRouter.setGitSource,
                                    {
                                        ...expected,
                                        ...selection(),
                                    },
                                    { context },
                                );
                            case "pull":
                                return call(resourcesRouter.pullGitSource, expected, {
                                    context,
                                });
                            case "push":
                                return call(
                                    resourcesRouter.pushGitSource,
                                    {
                                        ...expected,
                                        spec: draftSpec,
                                        expectedRevision: revision,
                                        message: "OAuth push",
                                    },
                                    { context },
                                );
                        }
                    }

                    beforeEach(async () => {
                        await db
                            .update(resources)
                            .set({
                                gitConnectionId: oauthConnectionId,
                                gitSource: {
                                    repositoryUrl: repositories[0]!.url,
                                    branch: "release",
                                    path: "deploy/compose.yaml",
                                    revision,
                                },
                            })
                            .where(eq(resources.id, resourceId));
                    });

                    it("commits refreshed credentials before resource work without exhausting the pool", async () => {
                        expect(db.$client.options.max).toBe(1);
                        const before = await storedResource();
                        // This root-DB read also proves discovery runs outside either transaction.
                        discover.mockImplementationOnce(async () => {
                            expect(
                                decryptGitCredentials(
                                    (await storedAccount()).encryptedCredentials!,
                                    {
                                        organizationId,
                                        connectionId: oauthConnectionId,
                                    },
                                ),
                            ).toEqual(refreshed);

                            return { repositories, truncated: false };
                        });
                        read.mockImplementation(async (_repo, path) => ({
                            revision: nextRevision,
                            path,
                            content: draftSpec,
                        }));
                        const result = await operate();
                        expect(result).toMatchObject({
                            projectId,
                            draftSpec,
                            spec: action === "create" ? null : deployedSpec,
                            gitConnectionId: oauthConnectionId,
                            gitSource: { ...before.gitSource, revision: nextRevision },
                        });

                        if (action !== "create") {
                            expect(result).toMatchObject({
                                id: resourceId,
                                settings: before.settings,
                            });
                        }

                        expect(
                            (
                                await db
                                    .select()
                                    .from(resources)
                                    .where(eq(resources.id, result!.id))
                            )[0],
                        ).toEqual(result);
                        expect(refresh).toHaveBeenCalledExactlyOnceWith(oauthCredentials, [
                            configuration,
                        ]);
                        expect(discover).toHaveBeenCalledExactlyOnceWith({
                            provider,
                            serverUrl,
                            token: refreshed.password,
                        });

                        const repo = {
                            url: repositories[0]!.url,
                            branch: "release",
                            credentials: refreshed,
                        };

                        if (action === "push") {
                            expect(push).toHaveBeenCalledExactlyOnceWith(
                                repo,
                                expect.objectContaining({
                                    content: draftSpec,
                                    expectedRevision: revision,
                                }),
                            );
                        } else {
                            expect(read).toHaveBeenCalledExactlyOnceWith(
                                repo,
                                "deploy/compose.yaml",
                            );
                            expect(push).not.toHaveBeenCalled();
                        }

                        expect(db.$client.waitingCount).toBe(0);
                        expectNoCredentials(
                            result,
                            (await storedAccount()).encryptedCredentials,
                            refreshed.password,
                            refreshed.refreshToken,
                        );
                    });

                    it("keeps rotated credentials but leaves resources unchanged when Git fails", async () => {
                        const before = await db.select().from(resources).orderBy(resources.id);

                        const failure = new ORPCError("BAD_GATEWAY", {
                            message: "Git unavailable",
                        });

                        if (action === "push") push.mockRejectedValueOnce(failure);
                        else read.mockRejectedValueOnce(failure);
                        await expect(operate()).rejects.toMatchObject({ code: "BAD_GATEWAY" });
                        expect(refresh).toHaveBeenCalledExactlyOnceWith(oauthCredentials, [
                            configuration,
                        ]);
                        expect(
                            decryptGitCredentials((await storedAccount()).encryptedCredentials!, {
                                organizationId,
                                connectionId: oauthConnectionId,
                            }),
                        ).toEqual(refreshed);
                        expect(await db.select().from(resources).orderBy(resources.id)).toEqual(
                            before,
                        );
                    });

                    if (action === "create") return;

                    it.each(["draft", "source"] as const)(
                        "rejects a stale %s before refreshing credentials",
                        async (changed) => {
                            const before = await storedResource();
                            const accountBefore = await storedAccount();
                            const expected = snapshot();

                            if (changed === "draft") expected.expectedSpec = draftSpec;
                            else expected.expectedSource.branch = "stale-branch";
                            await expect(operate(expected)).rejects.toMatchObject({
                                code: "CONFLICT",
                            });
                            expect(await storedResource()).toEqual(before);
                            expect(await storedAccount()).toEqual(accountBefore);
                            expectNoGitIO();
                        },
                    );

                    it.each(["draft", "source"] as const)(
                        "revalidates a %s changed during preparation before writing or pushing",
                        async (changed) => {
                            let concurrent: typeof resources.$inferSelect | undefined;
                            // Deterministically interleave a real editor after refresh but before the resource lock.
                            discover.mockImplementationOnce(async () => {
                                concurrent =
                                    changed === "draft"
                                        ? await call(
                                              resourcesRouter.updateComposeSpec,
                                              {
                                                  ...snapshot(),
                                                  spec: draftSpec,
                                              },
                                              { context: memberContext },
                                          )
                                        : await call(resourcesRouter.detachGitSource, snapshot(), {
                                              context: memberContext,
                                          });

                                return { repositories, truncated: false };
                            });
                            await expect(operate()).rejects.toMatchObject({ code: "CONFLICT" });
                            expect(concurrent).toBeDefined();
                            expect(await storedResource()).toEqual(concurrent);
                            expect(push).not.toHaveBeenCalled();
                            expect(refresh).toHaveBeenCalledExactlyOnceWith(oauthCredentials, [
                                configuration,
                            ]);
                            expect(
                                decryptGitCredentials(
                                    (await storedAccount()).encryptedCredentials!,
                                    {
                                        organizationId,
                                        connectionId: oauthConnectionId,
                                    },
                                ),
                            ).toEqual(refreshed);
                        },
                    );
                },
            );

            it.each(["missing", "id", "provider", "host", "path"] as const)(
                "rejects a changed OAuth %s before refresh or token use",
                async (changed) => {
                    const configured = { ...configuration };

                    if (changed === "id") configured.id = "another-app";

                    if (changed === "provider")
                        configured.provider = provider === "github" ? "forgejo" : "github";

                    if (changed === "host") configured.serverUrl = "https://rogue.example";

                    if (changed === "path") configured.serverUrl = `${serverUrl}/other`;
                    oauthProviders.mockResolvedValue(changed === "missing" ? [] : [configured]);
                    const before = await db.select().from(gitConnections);
                    await expect(
                        call(
                            connectionsRouter.getRepositories,
                            { connectionId: oauthConnectionId },
                            { context: memberContext },
                        ),
                    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
                    expect(await db.select().from(gitConnections)).toEqual(before);
                    expectNoGitIO();
                },
            );

            it("rejects foreign organizations before reading OAuth configuration or refreshing", async () => {
                await expect(
                    call(
                        connectionsRouter.getRepositories,
                        { connectionId: oauthConnectionId },
                        { context: foreignContext },
                    ),
                ).rejects.toMatchObject({ code: "NOT_FOUND" });
                expect(oauthProviders).not.toHaveBeenCalled();
                expectNoGitIO();
            });

            it("allows explicit token replacement to recover an unconfigured OAuth account", async () => {
                oauthProviders.mockResolvedValue([]);

                const updated = await call(
                    connectionsRouter.update,
                    {
                        connectionId: oauthConnectionId,
                        name: "Token account",
                        credentials: input.credentials,
                    },
                    { context: adminContext },
                );

                expect(updated.authType).toBe("token");

                const [stored] = await db
                    .select()
                    .from(gitConnections)
                    .where(eq(gitConnections.id, oauthConnectionId));

                expect(
                    decryptGitCredentials(stored!.encryptedCredentials!, {
                        organizationId,
                        connectionId: oauthConnectionId,
                    }),
                ).toEqual(gitCredentials);
                expect(refresh).not.toHaveBeenCalled();
                expect(oauthProviders).not.toHaveBeenCalled();
                expectNoCredentials(
                    updated,
                    stored!.encryptedCredentials,
                    oauthCredentials.refreshToken,
                );
            });
        });
    });

    it("allows organization deletion to cascade through connected resources", async () => {
        const rollback = new Error("test rollback");
        await expect(
            db
                .transaction(async (tx) => {
                    await tx.delete(organization).where(eq(organization.id, organizationId));
                    expect(
                        await tx.select().from(resources).where(eq(resources.id, resourceId)),
                    ).toEqual([]);
                    expect(
                        await tx
                            .select()
                            .from(gitConnections)
                            .where(eq(gitConnections.id, connectionId)),
                    ).toEqual([]);
                    throw rollback;
                })
                .catch((error) => {
                    throw error.cause ?? error;
                }),
        ).rejects.toBe(rollback);
    });

    it("can replace credentials that can no longer be decrypted", async () => {
        await db
            .update(gitConnections)
            .set({ encryptedCredentials: "unreadable-old-envelope" })
            .where(eq(gitConnections.id, connectionId));

        const result = await call(
            connectionsRouter.update,
            {
                connectionId,
                name: "Recovered",
                credentials,
            },
            { context: adminContext },
        );

        expect(result.hasCredentials).toBe(true);
        expectNoCredentials(result);
        await call(
            connectionsRouter.readFile,
            { connectionId, repositoryUrl, branch: "main", path: "deploy/compose.yaml" },
            { context: memberContext },
        );
        expect(read).toHaveBeenCalledWith(
            { url: repositoryUrl, branch: "main", credentials },
            "deploy/compose.yaml",
        );
    });

    it("lets members browse/read using decrypted credentials without returning them", async () => {
        const files = await call(
            connectionsRouter.listFiles,
            { connectionId, repositoryUrl, branch: "main" },
            { context: memberContext },
        );

        expect(files).toEqual({ revision, files: ["deploy/compose.yaml"] });
        expect(list).toHaveBeenCalledWith({ url: repositoryUrl, branch: "main", credentials });

        const file = await call(
            connectionsRouter.readFile,
            { connectionId, repositoryUrl, branch: "release", path: "deploy/compose.yaml" },
            { context: memberContext },
        );

        expect(file).toEqual({ revision, path: "deploy/compose.yaml", content: rawSpec });
        expect(read).toHaveBeenCalledWith(
            { url: repositoryUrl, branch: "release", credentials },
            "deploy/compose.yaml",
        );
        expectNoCredentials({ files, file });
    });

    it.each(["create", "testConnection", "update", "delete", "pushFile", "pushGitSource"] as const)(
        "denies member %s before Git I/O or mutation",
        async (action) => {
            const context = memberContext;
            const before = await storedConnection();
            const resourceBefore = await storedResource();

            const actions = {
                testConnection: () =>
                    call(connectionsRouter.testConnection, genericAccount, { context }),
                create: () =>
                    call(
                        connectionsRouter.create,
                        { name: "Forbidden", ...genericAccount },
                        { context },
                    ),
                update: () =>
                    call(
                        connectionsRouter.update,
                        { connectionId, name: "Forbidden" },
                        { context },
                    ),
                delete: () => call(connectionsRouter.delete, { connectionId }, { context }),
                pushFile: () =>
                    call(
                        connectionsRouter.pushFile,
                        {
                            connectionId,
                            repositoryUrl,
                            branch: "main",
                            path: "compose.yaml",
                            content: draftSpec,
                            expectedRevision: revision,
                            message: "Forbidden",
                        },
                        { context },
                    ),
                pushGitSource: () => call(resourcesRouter.pushGitSource, pushInput(), { context }),
            };

            await expect(actions[action]()).rejects.toMatchObject({ code: "FORBIDDEN" });
            expect(await storedConnection()).toEqual(before);
            expect(await storedResource()).toEqual(resourceBefore);
            expectNoGitIO();
        },
    );

    it("rejects unauthenticated and stale/forged organization membership", async () => {
        await expect(
            call(connectionsRouter.list, undefined, {
                context: { ...memberContext, session: null },
            }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

        const forged = {
            ...memberContext,
            session: {
                ...memberContext.session!,
                session: {
                    ...memberContext.session!.session,
                    activeOrganizationId: foreignOrganizationId,
                },
            },
        };

        await expect(
            call(connectionsRouter.list, undefined, { context: forged }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await db.$client.query("DELETE FROM member WHERE user_id = $1 AND organization_id = $2", [
            memberContext.session!.user.id,
            organizationId,
        ]);

        try {
            await expect(
                call(
                    connectionsRouter.readFile,
                    { connectionId, repositoryUrl, branch: "main", path: "compose.yaml" },
                    { context: memberContext },
                ),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
        } finally {
            await db.$client.query(
                "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'member', now())",
                [randomUUID(), organizationId, memberContext.session!.user.id],
            );
        }

        expectNoGitIO();
    });

    it.each([
        "testConnection",
        "getRepositories",
        "listFiles",
        "readFile",
        "update",
        "delete",
        "pushFile",
        "import",
        "attach",
    ] as const)("hides foreign connection IDs from %s", async (action) => {
        const context = adminContext;
        const input = { connectionId: foreignConnectionId, repositoryUrl, branch: "main" };
        const before = await storedResource();

        const actions = {
            testConnection: () =>
                call(
                    connectionsRouter.testConnection,
                    { connectionId: foreignConnectionId },
                    { context },
                ),
            getRepositories: () =>
                call(
                    connectionsRouter.getRepositories,
                    { connectionId: foreignConnectionId },
                    { context },
                ),
            listFiles: () => call(connectionsRouter.listFiles, input, { context }),
            readFile: () =>
                call(connectionsRouter.readFile, { ...input, path: "compose.yaml" }, { context }),
            update: () =>
                call(
                    connectionsRouter.update,
                    { connectionId: foreignConnectionId, name: "Foreign" },
                    { context },
                ),
            delete: () => call(connectionsRouter.delete, input, { context }),
            pushFile: () =>
                call(
                    connectionsRouter.pushFile,
                    {
                        ...input,
                        path: "compose.yaml",
                        content: draftSpec,
                        expectedRevision: revision,
                        message: "Foreign",
                    },
                    { context },
                ),
            import: () =>
                call(
                    resourcesRouter.createResource,
                    { projectId, name: "Foreign", git: { ...source(), ...input } },
                    { context },
                ),
            attach: () =>
                call(
                    resourcesRouter.setGitSource,
                    { ...target(), ...source(), ...input, expectedSpec: rawSpec },
                    { context },
                ),
        };

        await expect(actions[action]()).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await storedResource()).toEqual(before);
        expectNoGitIO();
    });

    it.each(["foreign", "mismatched", "internal"] as const)(
        "blocks every resource Git operation for %s project/resource IDs",
        async (kind) => {
            const context = adminContext;

            if (kind === "internal")
                await db
                    .update(projects)
                    .set({ isInternal: true })
                    .where(eq(projects.id, projectId));

            const input = target();

            if (kind === "foreign") input.projectId = foreignProjectId;

            if (kind !== "internal") input.resourceId = foreignResourceId;

            const before = await storedResource();

            const actions = [
                () =>
                    call(
                        resourcesRouter.setGitSource,
                        { ...input, ...source(), expectedSpec: rawSpec },
                        { context },
                    ),
                () =>
                    call(
                        resourcesRouter.pullGitSource,
                        { ...input, expectedSpec: rawSpec },
                        { context },
                    ),
                () => call(resourcesRouter.detachGitSource, input, { context }),
                () =>
                    call(resourcesRouter.pushGitSource, { ...pushInput(), ...input }, { context }),
                () =>
                    call(
                        resourcesRouter.updateComposeSpec,
                        { ...input, spec: draftSpec },
                        { context },
                    ),
            ];

            for (const action of actions)
                await expect(action()).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await storedResource()).toEqual(before);
            expectNoGitIO();
        },
    );

    it("imports raw YAML from a directory and uses the read revision, not the earlier listing", async () => {
        read.mockResolvedValueOnce({
            revision: nextRevision,
            path: "deploy/compose.yaml",
            content: rawSpec,
        });

        const imported = await call(
            resourcesRouter.createResource,
            { projectId, name: "Imported", git: source() },
            { context: memberContext },
        );

        expect(imported).toMatchObject({
            draftSpec: rawSpec,
            spec: null,
            gitConnectionId: connectionId,
            gitSource: {
                repositoryUrl,
                branch: "release",
                path: "deploy/compose.yaml",
                revision: nextRevision,
            },
        });
        expect(read).toHaveBeenCalledWith(
            { url: repositoryUrl, branch: "release", credentials },
            "deploy/compose.yaml",
        );
        expect(
            (await db.select().from(resources).where(eq(resources.id, imported!.id)))[0],
        ).toEqual(imported);
        expectNoCredentials(imported, (await storedConnection()).encryptedCredentials);
        expect(push).not.toHaveBeenCalled();
    });

    it("allows member attach, pull, and detach without changing deployed source, settings or pushing", async () => {
        await db
            .update(resources)
            .set({ draftSpec: null, gitConnectionId: null, gitSource: null })
            .where(eq(resources.id, resourceId));

        const attached = await call(
            resourcesRouter.setGitSource,
            { ...target(), ...source(), expectedSpec: null, expectedSource: null },
            { context: memberContext },
        );

        expect(attached).toMatchObject({
            draftSpec: rawSpec,
            spec: deployedSpec,
            gitConnectionId: connectionId,
            gitSource: {
                repositoryUrl,
                path: "deploy/compose.yaml",
                branch: "release",
                revision,
            },
        });
        read.mockResolvedValueOnce({
            revision: nextRevision,
            path: "deploy/compose.yaml",
            content: draftSpec,
        });

        const pulled = await call(
            resourcesRouter.pullGitSource,
            { ...target(), expectedSpec: rawSpec },
            { context: memberContext },
        );

        expect(pulled).toMatchObject({
            draftSpec,
            spec: deployedSpec,
            gitSource: { revision: nextRevision },
            settings: attached.settings,
        });

        const detached = await call(
            resourcesRouter.detachGitSource,
            {
                ...target(),
                expectedSpec: draftSpec,
                expectedSource: { ...expectedSource(), revision: nextRevision },
            },
            { context: memberContext },
        );

        expect(detached).toMatchObject({
            draftSpec,
            spec: deployedSpec,
            gitConnectionId: null,
            gitSource: null,
            settings: attached.settings,
        });
        expectNoCredentials({ attached, pulled, detached });
        expect(push).not.toHaveBeenCalled();
    });

    it("saves a member's draft locally without Git I/O or changing deployed source or source metadata", async () => {
        const before = await storedResource();

        const saved = await call(
            resourcesRouter.updateComposeSpec,
            { ...target(), spec: draftSpec },
            { context: memberContext },
        );

        expect(saved).toMatchObject({
            draftSpec,
            spec: deployedSpec,
            gitConnectionId: before.gitConnectionId,
            gitSource: before.gitSource,
            settings: before.settings,
        });
        expect(await storedResource()).toEqual(saved);
        expectNoCredentials(saved);
        expectNoGitIO();
    });

    it("rejects a stale save after another editor saves, then accepts a refreshed snapshot", async () => {
        const snapshot = target();

        const saved = await call(
            resourcesRouter.updateComposeSpec,
            { ...snapshot, spec: draftSpec },
            { context: memberContext },
        );

        await expect(
            call(
                resourcesRouter.updateComposeSpec,
                { ...snapshot, spec: rawSpec },
                { context: adminContext },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await storedResource()).toEqual(saved);

        const refreshed = await call(
            resourcesRouter.updateComposeSpec,
            { ...snapshot, spec: rawSpec, expectedSpec: draftSpec },
            { context: adminContext },
        );

        expect(refreshed).toMatchObject({
            draftSpec: rawSpec,
            spec: deployedSpec,
            gitSource: saved.gitSource,
        });
        expectNoGitIO();
    });

    it("saves a new local draft with null expectedSpec and expectedSource", async () => {
        await db
            .update(resources)
            .set({ draftSpec: null, spec: null, gitConnectionId: null, gitSource: null })
            .where(eq(resources.id, resourceId));

        const saved = await call(
            resourcesRouter.updateComposeSpec,
            { ...target(), spec: draftSpec, expectedSpec: null, expectedSource: null },
            { context: memberContext },
        );

        expect(saved).toMatchObject({
            draftSpec,
            spec: null,
            gitConnectionId: null,
            gitSource: null,
        });
        expect(await storedResource()).toEqual(saved);
        expectNoGitIO();
    });

    describe.each(["save", "attach", "pull", "detach", "push"] as const)(
        "%s snapshot preconditions",
        (action) => {
            function mutate(snapshot: {
                expectedSpec: string | null;
                expectedSource: ReturnType<typeof expectedSource> | null;
            }) {
                const input = { projectId, resourceId, ...snapshot };
                const context = action === "push" ? adminContext : memberContext;

                const actions = {
                    save: () =>
                        call(
                            resourcesRouter.updateComposeSpec,
                            { ...input, spec: draftSpec },
                            { context },
                        ),
                    attach: () =>
                        call(resourcesRouter.setGitSource, { ...input, ...source() }, { context }),
                    pull: () => call(resourcesRouter.pullGitSource, input, { context }),
                    detach: () => call(resourcesRouter.detachGitSource, input, { context }),
                    push: () =>
                        call(
                            resourcesRouter.pushGitSource,
                            {
                                ...input,
                                spec: draftSpec,
                                expectedRevision: revision,
                                message: "Stale editor",
                            },
                            { context },
                        ),
                };

                return actions[action]();
            }

            it.each([
                "path",
                "repository",
                "branch",
                "connection",
                "revision",
                "detached",
                "attached",
            ] as const)(
                "rejects a changed %s with identical saved text before Git I/O",
                async (changed) => {
                    const snapshot: Parameters<typeof mutate>[0] = target();

                    if (changed === "attached" || changed === "detached") {
                        await call(resourcesRouter.detachGitSource, target(), {
                            context: memberContext,
                        });

                        if (changed === "attached") {
                            snapshot.expectedSource = null;
                            await call(
                                resourcesRouter.setGitSource,
                                {
                                    ...target(),
                                    ...source(),
                                    expectedSource: null,
                                },
                                { context: memberContext },
                            );
                        }
                    } else if (changed === "revision") {
                        read.mockResolvedValueOnce({
                            revision: nextRevision,
                            path: "deploy/compose.yaml",
                            content: rawSpec,
                        });
                        await call(resourcesRouter.pullGitSource, target(), {
                            context: memberContext,
                        });
                    } else {
                        const replacement = { ...source(), path: "deploy/compose.yaml" };

                        if (changed === "path") {
                            replacement.path = "other/compose.yaml";
                            list.mockResolvedValue({
                                revision,
                                files: ["deploy/compose.yaml", replacement.path],
                            });
                        } else if (changed === "branch") {
                            replacement.branch = "other-branch";
                        } else if (changed === "repository") {
                            replacement.repositoryUrl = "https://example.com/team/other.git";
                            await call(
                                connectionsRouter.update,
                                {
                                    connectionId,
                                    name: "More repositories",
                                    repositories: [
                                        ...genericAccount.repositories,
                                        {
                                            url: replacement.repositoryUrl,
                                            name: "team/other",
                                            defaultBranch: "main",
                                        },
                                    ],
                                },
                                { context: adminContext },
                            );
                        } else {
                            const connection = await call(
                                connectionsRouter.create,
                                {
                                    name: "Another connection",
                                    ...genericAccount,
                                },
                                { context: adminContext },
                            );

                            replacement.connectionId = connection.id;
                        }

                        await call(
                            resourcesRouter.setGitSource,
                            {
                                ...target(),
                                ...replacement,
                            },
                            { context: memberContext },
                        );
                    }

                    const current = await storedResource();
                    expect(current.draftSpec).toBe(snapshot.expectedSpec);
                    expect(current.spec).toBe(deployedSpec);

                    if (changed !== "revision" && changed !== "detached") {
                        expect(current.gitSource?.revision).toBe(revision);
                    }

                    const currentSource = current.gitSource
                        ? { connectionId: current.gitConnectionId, ...current.gitSource }
                        : null;

                    expect(currentSource).not.toEqual(snapshot.expectedSource);
                    vi.clearAllMocks();

                    await expect(mutate(snapshot)).rejects.toMatchObject({ code: "CONFLICT" });
                    expect(await storedResource()).toEqual(current);
                    expectNoGitIO();
                },
            );

            it.each(["expectedSpec", "expectedSource"])(
                "requires %s rather than silently accepting an unguarded mutation",
                async (field) => {
                    const before = await storedResource();
                    const snapshot = target();
                    // Exercise malformed runtime input without weakening the typed API client.
                    Reflect.deleteProperty(snapshot, field);
                    await expect(mutate(snapshot)).rejects.toMatchObject({
                        code: "BAD_REQUEST",
                    });
                    expect(await storedResource()).toEqual(before);
                    expectNoGitIO();
                },
            );
        },
    );

    it.each(["save", "attach", "pull", "detach", "push"] as const)(
        "rejects stale expectedSpec during %s without Git I/O or mutation",
        async (action) => {
            const before = await storedResource();
            const context = adminContext;

            const actions = {
                save: () =>
                    call(
                        resourcesRouter.updateComposeSpec,
                        { ...target(), spec: draftSpec, expectedSpec: null },
                        { context },
                    ),
                attach: () =>
                    call(
                        resourcesRouter.setGitSource,
                        { ...target(), ...source(), expectedSpec: null },
                        { context },
                    ),
                pull: () =>
                    call(
                        resourcesRouter.pullGitSource,
                        { ...target(), expectedSpec: draftSpec },
                        { context },
                    ),
                push: () =>
                    call(
                        resourcesRouter.pushGitSource,
                        { ...pushInput(), expectedSpec: draftSpec },
                        { context },
                    ),
                detach: () =>
                    call(
                        resourcesRouter.detachGitSource,
                        { ...target(), expectedSpec: draftSpec },
                        { context },
                    ),
            };

            await expect(actions[action]()).rejects.toMatchObject({ code: "CONFLICT" });
            expect(await storedResource()).toEqual(before);
            expectNoGitIO();
        },
    );

    it("rejects a stale stored Git revision before pushing", async () => {
        const before = await storedResource();
        await expect(
            call(
                resourcesRouter.pushGitSource,
                { ...pushInput(), expectedRevision: nextRevision },
                { context: adminContext },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await storedResource()).toEqual(before);
        expectNoGitIO();
    });

    it.each(["CONFLICT", "BAD_GATEWAY"] as const)(
        "preserves draft and revision when remote push fails with %s",
        async (code) => {
            const before = await storedResource();
            push.mockRejectedValueOnce(new ORPCError(code, { message: "Git push failed" }));
            await expect(
                call(resourcesRouter.pushGitSource, pushInput(), { context: adminContext }),
            ).rejects.toMatchObject({ code });
            expect(push).toHaveBeenCalledOnce();
            expect(push.mock.calls[0]![1].expectedRevision).toBe(revision);
            expect(await storedResource()).toEqual(before);
        },
    );

    it("pushes as the admin and persists the exact draft and returned revision", async () => {
        const result = await call(resourcesRouter.pushGitSource, pushInput(), {
            context: adminContext,
        });

        expect(push).toHaveBeenCalledExactlyOnceWith(
            { url: repositoryUrl, branch: "release", credentials },
            {
                path: "deploy/compose.yaml",
                content: draftSpec,
                expectedRevision: revision,
                message: "Update Compose",
                author: { name: "admin", email: "admin@example.test" },
            },
        );
        expect(result).toMatchObject({
            draftSpec,
            spec: deployedSpec,
            gitSource: {
                repositoryUrl,
                path: "deploy/compose.yaml",
                branch: "release",
                revision: nextRevision,
            },
        });
        expect(await storedResource()).toEqual(result);
        expectNoCredentials(result);
    });

    it.each(["services: [", "not-a-compose-document"])(
        "rejects invalid Compose push before Git I/O or mutation: %s",
        async (spec) => {
            const before = await storedResource();
            await expect(
                call(
                    resourcesRouter.pushGitSource,
                    { ...pushInput(), spec },
                    { context: adminContext },
                ),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(await storedResource()).toEqual(before);
            expectNoGitIO();
        },
    );

    it("allows direct admin file pushes, forwarding optimistic revision and author without changing drafts", async () => {
        const before = await storedResource();

        const input = {
            connectionId,
            repositoryUrl,
            branch: "release",
            path: "deploy/compose.yaml",
            content: draftSpec,
            expectedRevision: revision,
            message: "Direct edit",
        };

        const result = await call(connectionsRouter.pushFile, input, { context: adminContext });
        expect(result).toEqual({ revision: nextRevision });
        expect(push).toHaveBeenCalledExactlyOnceWith(
            { url: repositoryUrl, branch: "release", credentials },
            expect.objectContaining({
                path: input.path,
                content: draftSpec,
                expectedRevision: revision,
                message: input.message,
                author: { name: "admin", email: "admin@example.test" },
            }),
        );
        expectNoCredentials(result);
        push.mockRejectedValueOnce(
            new ORPCError("CONFLICT", { message: "Git branch changed; reload before saving" }),
        );
        await expect(
            call(connectionsRouter.pushFile, input, { context: adminContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await storedResource()).toEqual(before);
    });

    describe.each(["listFiles", "readFile", "pushFile"] as const)(
        "%s selection schema",
        (action) => {
            it.each(["repositoryUrl", "branch"])("requires %s before Git I/O", async (field) => {
                const input = {
                    connectionId,
                    repositoryUrl,
                    branch: "main",
                    path: "compose.yaml",
                    content: rawSpec,
                    expectedRevision: revision,
                    message: "Schema test",
                };

                Reflect.deleteProperty(input, field);
                const before = await storedConnection();

                const attempts = {
                    listFiles: () =>
                        call(connectionsRouter.listFiles, input, { context: adminContext }),
                    readFile: () =>
                        call(connectionsRouter.readFile, input, { context: adminContext }),
                    pushFile: () =>
                        call(connectionsRouter.pushFile, input, { context: adminContext }),
                };

                await expect(attempts[action]()).rejects.toMatchObject({
                    code: "BAD_REQUEST",
                });
                expect(await storedConnection()).toEqual(before);
                expectNoGitIO();
            });
        },
    );

    it("requires repositoryUrl in resource sources and expected source snapshots", async () => {
        const git = source();
        const snapshot = target();
        Reflect.deleteProperty(git, "repositoryUrl");
        Reflect.deleteProperty(snapshot.expectedSource, "repositoryUrl");
        const before = await storedResource();

        const attempts = [
            () =>
                call(
                    resourcesRouter.createResource,
                    { projectId, name: "Invalid", git },
                    { context: memberContext },
                ),
            () =>
                call(
                    resourcesRouter.setGitSource,
                    { ...target(), ...git },
                    { context: memberContext },
                ),
            () =>
                call(
                    resourcesRouter.updateComposeSpec,
                    { ...snapshot, spec: draftSpec },
                    { context: memberContext },
                ),
            () => call(resourcesRouter.pullGitSource, snapshot, { context: memberContext }),
            () => call(resourcesRouter.detachGitSource, snapshot, { context: memberContext }),
            () =>
                call(
                    resourcesRouter.pushGitSource,
                    { ...pushInput(), ...snapshot },
                    { context: adminContext },
                ),
        ];

        for (const attempt of attempts)
            await expect(attempt()).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await storedResource()).toEqual(before);
        expectNoGitIO();
    });

    it("does not forward an unsolicited force flag or bypass optimistic push conflicts", async () => {
        const before = await storedResource();

        const fileInput = {
            connectionId,
            repositoryUrl,
            branch: "main",
            path: "compose.yaml",
            content: rawSpec,
            expectedRevision: revision,
            message: "No force",
            force: true,
        };

        const resourceInput = { ...pushInput(), force: true };
        push.mockRejectedValue(new ORPCError("CONFLICT", { message: "Remote changed" }));
        await expect(
            call(connectionsRouter.pushFile, fileInput, { context: adminContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
            call(resourcesRouter.pushGitSource, resourceInput, { context: adminContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(push).toHaveBeenCalledTimes(2);

        for (const [, options] of push.mock.calls) {
            expect(options).not.toHaveProperty("force");
            expect(options.expectedRevision).toBe(revision);
        }

        expect(await storedResource()).toEqual(before);
    });

    it.each(["NOT_FOUND", "BAD_GATEWAY", "TIMEOUT"] as const)(
        "leaves the entire resource unchanged when pull fails with %s",
        async (code) => {
            const before = await storedResource();
            read.mockRejectedValueOnce(new ORPCError(code, { message: "Git read failed" }));
            await expect(
                call(
                    resourcesRouter.pullGitSource,
                    { ...target(), expectedSpec: rawSpec },
                    { context: memberContext },
                ),
            ).rejects.toMatchObject({ code });
            expect(await storedResource()).toEqual(before);
            expect(push).not.toHaveBeenCalled();
        },
    );

    it.each(["services: [", "not-a-compose-document"])(
        "rejects invalid Compose on import/attach without mutation: %s",
        async (content) => {
            const before = await storedResource();

            const rowsBefore = await db
                .select()
                .from(resources)
                .where(eq(resources.projectId, projectId));

            read.mockResolvedValue({
                revision: nextRevision,
                path: "deploy/compose.yaml",
                content,
            });
            await expect(
                call(
                    resourcesRouter.createResource,
                    { projectId, name: "Invalid", git: source() },
                    { context: memberContext },
                ),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            await expect(
                call(
                    resourcesRouter.setGitSource,
                    { ...target(), ...source(), expectedSpec: rawSpec },
                    { context: memberContext },
                ),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(await storedResource()).toEqual(before);
            expect(
                await db.select().from(resources).where(eq(resources.projectId, projectId)),
            ).toEqual(rowsBefore);
        },
    );

    it("rejects invalid pulled Compose without overwriting the saved draft or revision", async () => {
        const before = await storedResource();
        read.mockResolvedValueOnce({
            revision: nextRevision,
            path: "deploy/compose.yaml",
            content: "services: [",
        });

        const result = await call(
            resourcesRouter.pullGitSource,
            { ...target(), expectedSpec: rawSpec },
            { context: memberContext },
        ).catch((cause: unknown) => cause);

        expect.soft(result).toMatchObject({ code: "BAD_REQUEST" });
        expect(await storedResource()).toEqual(before);
    });

    it("rolls back connection create/update if repository verification fails", async () => {
        const before = await storedConnection();

        const rowsBefore = await db
            .select()
            .from(gitConnections)
            .where(eq(gitConnections.organizationId, organizationId));

        inspect.mockRejectedValue(
            new ORPCError("BAD_GATEWAY", { message: "Git operation failed" }),
        );
        await expect(
            call(
                connectionsRouter.create,
                { name: "Unavailable", ...genericAccount },
                { context: adminContext },
            ),
        ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
        await expect(
            call(
                connectionsRouter.update,
                { connectionId, name: "Unavailable", credentials: {} },
                { context: adminContext },
            ),
        ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
        expect(await storedConnection()).toEqual(before);
        expect(
            await db
                .select()
                .from(gitConnections)
                .where(eq(gitConnections.organizationId, organizationId)),
        ).toEqual(rowsBefore);
    });

    it("rejects embedded URL credentials without leaking them or calling Git", async () => {
        const error = await call(
            connectionsRouter.create,
            {
                name: "Unsafe",
                ...genericAccount,
                repositories: [
                    {
                        url: `https://${credentials.username}:${credentials.password}@example.com/repo.git`,
                        name: "repo",
                        defaultBranch: "main",
                    },
                ],
            },
            { context: adminContext },
        ).catch((cause: unknown) => cause);

        expect(error).toMatchObject({ code: "BAD_REQUEST" });
        expectNoCredentials(error);
        expectNoGitIO();
    });

    it("does not expose encrypted credentials or crypto causes when decryption fails", async () => {
        const before = await storedConnection();

        // A ciphertext bound to another connection must not be usable here.
        const [foreign] = await db
            .select()
            .from(gitConnections)
            .where(eq(gitConnections.id, foreignConnectionId));

        await db
            .update(gitConnections)
            .set({ encryptedCredentials: foreign!.encryptedCredentials })
            .where(eq(gitConnections.id, connectionId));

        const error = await call(
            connectionsRouter.readFile,
            { connectionId, repositoryUrl, branch: "main", path: "compose.yaml" },
            { context: memberContext },
        ).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "Unable to decrypt Git credentials" });
        expect(error).not.toHaveProperty("cause");
        expectNoCredentials(error, before.encryptedCredentials);
        expectNoCredentials(error, foreign!.encryptedCredentials);
        expectNoGitIO();
    });

    it("restricts deletion in the API and database until resources detach", async () => {
        const before = await storedResource();
        await expect(
            call(connectionsRouter.delete, { connectionId }, { context: adminContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
            db.$client.query("DELETE FROM git_connections WHERE id = $1", [connectionId]),
        ).rejects.toMatchObject({ code: "23503" });
        expect(await storedResource()).toEqual(before);
        expect(await storedConnection()).toBeDefined();
        await call(resourcesRouter.detachGitSource, target(), { context: memberContext });
        expect(
            await call(connectionsRouter.delete, { connectionId }, { context: adminContext }),
        ).toEqual({ success: true });
        expect(await storedConnection()).toBeUndefined();
        expect(await storedResource()).toMatchObject({ draftSpec: rawSpec, spec: deployedSpec });
        expectNoGitIO();
    });
});
