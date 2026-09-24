import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { gitConnections, resources } from "@stoat/db/schema/index";
import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationAdminProcedure, organizationProcedure } from "../..";
import {
    type GitCredentials,
    inspectGitRemote,
    listGitFiles,
    pushGitFile,
    readGitFile,
    validateGitBranch,
    validateGitUrl,
} from "../../git";
import {
    getGitAccount,
    listGitRepositories,
    validateGitServerUrl,
    type GitProvider,
    type GitDiscoveredRepository,
} from "../../git-provider";
import {
    createOrganizationGitOAuthProvider,
    getGitOAuthCallbackUrl,
    getOrganizationGitOAuthProviders,
    getPublicOrganizationGitOAuthProviders,
    GitOAuthError,
    refreshGitOAuthCredentials,
} from "../../git-oauth";
import { decryptGitCredentials, encryptGitCredentials } from "../../git-secrets";

const id = v.pipe(v.string(), v.uuid());

const name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

const branch = v.pipe(v.string(), v.minLength(1), v.maxLength(255));

const url = v.pipe(v.string(), v.maxLength(4096));

const credentialsInput = v.object({
    username: v.optional(v.pipe(v.string(), v.maxLength(1024))),
    password: v.optional(v.pipe(v.string(), v.maxLength(16384))),
    privateKey: v.optional(v.pipe(v.string(), v.maxLength(32768))),
    knownHosts: v.optional(v.pipe(v.string(), v.maxLength(65536))),
});

const repositoryInput = v.object({
    url,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    defaultBranch: branch,
});

const repositoriesInput = v.optional(v.pipe(v.array(repositoryInput), v.maxLength(100)));

const accountInput = {
    provider: v.picklist(["github", "forgejo", "generic"]),
    serverUrl: url,
    credentials: credentialsInput,
    repositories: repositoriesInput,
};

export const gitFilePath = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));

export const gitText = v.pipe(v.string(), v.maxLength(1024 * 1024));

export const gitRevision = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

export const gitMessage = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1000));

type Connection = typeof gitConnections.$inferSelect;

type Executor = Pick<Database, "select" | "update">;

function publicConnection(connection: Connection) {
    return {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        serverUrl: connection.serverUrl,
        authType: connection.authType,
        account: connection.account,
        repositories: connection.repositories,
        hasCredentials: Boolean(connection.encryptedCredentials),
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
    };
}

function knownRepositories(serverUrl: string, repositories: GitDiscoveredRepository[]) {
    const server = new URL(serverUrl);
    const basePath = server.pathname.replace(/\/$/, "");
    const seen = new Set<string>();

    return repositories.map((repository) => {
        const normalized = validateGitUrl(repository.url);
        const remote = new URL(normalized);

        // Credentials are scoped to this server, never sent to arbitrary repository URLs.
        if (
            remote.protocol !== server.protocol ||
            remote.host !== server.host ||
            (basePath && !remote.pathname.startsWith(`${basePath}/`)) ||
            seen.has(normalized)
        ) {
            throw new ORPCError("BAD_REQUEST", {
                message: "Repository URLs must be unique and belong to the configured Git server.",
            });
        }

        seen.add(normalized);

        return {
            ...repository,
            url: normalized,
            defaultBranch: validateGitBranch(repository.defaultBranch),
        };
    });
}

async function verifyAccount(input: {
    provider: GitProvider;
    serverUrl: string;
    credentials: GitCredentials;
    repositories?: GitDiscoveredRepository[];
}) {
    const serverUrl = validateGitServerUrl(input.serverUrl, input.provider);

    if (input.provider === "generic") {
        const repositories = knownRepositories(serverUrl, input.repositories ?? []);
        const first = repositories[0];

        if (!first)
            throw new ORPCError("BAD_REQUEST", {
                message:
                    "Generic Git has no account API. Add at least one known repository URL to test server access.",
            });
        const result = await inspectGitRemote({ url: first.url, credentials: input.credentials });
        first.defaultBranch = result.defaultBranch;

        return {
            serverUrl,
            account: null,
            credentials: input.credentials,
            repositories,
            repositoryCount: repositories.length,
            truncated: false,
        };
    }

    if (
        !input.credentials.password ||
        input.credentials.privateKey ||
        input.credentials.knownHosts
    ) {
        throw new ORPCError("BAD_REQUEST", {
            message: "An account access token is required for this provider.",
        });
    }

    const api = { provider: input.provider, serverUrl, token: input.credentials.password };
    const account = await getGitAccount(api);
    const result = await listGitRepositories(api);

    return {
        serverUrl,
        account,
        repositories: [],
        repositoryCount: result.repositories.length,
        truncated: result.truncated,
        credentials: {
            ...input.credentials,
            username: input.provider === "github" ? "x-access-token" : account.login,
        },
    };
}

// Call within a transaction: the connection lock serializes OAuth refresh-token rotation.
async function accountConnection(
    db: Executor,
    organizationId: string,
    connectionId: string,
    replacement?: GitCredentials,
) {
    const [connection] = await db
        .select()
        .from(gitConnections)
        .where(
            and(
                eq(gitConnections.id, connectionId),
                eq(gitConnections.organizationId, organizationId),
            ),
        )
        .for("update");

    if (!connection) throw new ORPCError("NOT_FOUND", { message: "Git connection not found." });

    let credentials =
        replacement ??
        (connection.encryptedCredentials
            ? decryptGitCredentials(connection.encryptedCredentials, {
                  organizationId,
                  connectionId,
              })
            : {});

    if (replacement === undefined && connection.authType === "oauth") {
        const providers = await getOrganizationGitOAuthProviders(db, organizationId);

        const configured = providers.find(
            (provider) => provider.id === credentials.oauthProviderId,
        );

        if (
            !configured ||
            configured.provider !== connection.provider ||
            configured.serverUrl !== connection.serverUrl
        ) {
            throw new ORPCError("BAD_REQUEST", {
                message:
                    "This OAuth application is no longer configured for this Git server. Reconnect the account.",
            });
        }

        const refreshed = await refreshGitOAuthCredentials(credentials, providers);

        if (refreshed !== credentials) {
            const [updated] = await db
                .update(gitConnections)
                .set({
                    encryptedCredentials: encryptGitCredentials(refreshed, {
                        organizationId,
                        connectionId,
                    }),
                })
                .where(eq(gitConnections.id, connectionId))
                .returning();

            Object.assign(connection, updated);
            credentials = refreshed;
        }
    }

    return { connection, credentials };
}

async function repositoriesFor(connection: Connection, credentials: GitCredentials) {
    if (connection.provider === "generic")
        return {
            repositories: knownRepositories(connection.serverUrl, connection.repositories),
            truncated: false,
        };

    if (!credentials.password)
        throw new ORPCError("BAD_REQUEST", {
            message: "Reconnect this account with an access token or OAuth.",
        });

    return listGitRepositories({
        provider: connection.provider,
        serverUrl: connection.serverUrl,
        token: credentials.password,
    });
}

export async function getGitConnection(
    db: Database,
    organizationId: string,
    connectionId: string,
    repositoryUrl: string,
    requestedBranch: string,
) {
    // Commit token rotation before downstream network work that may fail.
    const { connection, credentials } = await db.transaction((tx) =>
        accountConnection(tx, organizationId, connectionId),
    );

    const selected = validateGitUrl(repositoryUrl);
    const result = await repositoriesFor(connection, credentials);

    if (!result.repositories.some((repository) => repository.url === selected)) {
        throw new ORPCError("NOT_FOUND", {
            message: result.truncated
                ? "Repository not found in the discovery limit. Narrow this token's repository access."
                : "Repository is not available through this Git account.",
        });
    }

    return { url: selected, branch: validateGitBranch(requestedBranch), credentials };
}

export const connectionsRouter = {
    oauthSetup: organizationAdminProcedure.handler(() => ({
        callbackUrl: getGitOAuthCallbackUrl(),
    })),
    createOAuthProvider: organizationAdminProcedure
        .use(async ({ next }) => {
            try {
                return await next();
            } catch (error) {
                // Input validation errors include the raw input in their cause. Strip that too.
                const code =
                    error instanceof GitOAuthError
                        ? error.code
                        : error instanceof ORPCError && error.code === "BAD_REQUEST"
                          ? "invalid_request"
                          : "configuration";

                let status: "FORBIDDEN" | "BAD_REQUEST" | "INTERNAL_SERVER_ERROR" =
                    "INTERNAL_SERVER_ERROR";

                if (code === "forbidden") status = "FORBIDDEN";

                if (code === "invalid_request") status = "BAD_REQUEST";

                throw new ORPCError(status, {
                    message:
                        code === "invalid_request"
                            ? "Invalid Git OAuth application configuration."
                            : "Unable to save Git OAuth application.",
                });
            }
        })
        .input(
            v.object({
                organizationId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
                name,
                provider: v.picklist(["github", "forgejo"]),
                serverUrl: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
                clientId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
                clientSecret: v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
            }),
        )
        .handler(({ context: { db, organizationId, session }, input }) => {
            const { organizationId: requestedOrganizationId, ...configuration } = input;

            if (requestedOrganizationId !== organizationId) throw new GitOAuthError("forbidden");

            return createOrganizationGitOAuthProvider(
                db,
                { organizationId, userId: session.user.id },
                configuration,
            );
        }),
    list: organizationProcedure.handler(
        async ({ context: { db, organizationId, organizationRole } }) => ({
            organizationId,
            connections: (
                await db
                    .select()
                    .from(gitConnections)
                    .where(eq(gitConnections.organizationId, organizationId))
                    .orderBy(asc(gitConnections.name))
            ).map(publicConnection),
            canManage: organizationRole
                .split(",")
                .some((role) => ["owner", "admin"].includes(role.trim())),
            oauthProviders: await getPublicOrganizationGitOAuthProviders(db, organizationId),
        }),
    ),
    testConnection: organizationAdminProcedure
        .input(
            v.union([
                v.object(accountInput),
                v.object({
                    connectionId: id,
                    credentials: v.optional(credentialsInput),
                    repositories: repositoriesInput,
                }),
            ]),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            let result;

            if ("connectionId" in input) {
                const { connection, credentials } = await db.transaction((tx) =>
                    accountConnection(tx, organizationId, input.connectionId, input.credentials),
                );

                result = await verifyAccount({
                    ...connection,
                    credentials,
                    repositories: input.repositories ?? connection.repositories,
                });
            } else result = await verifyAccount(input);

            return {
                account: result.account,
                repositoryCount: result.repositoryCount,
                truncated: result.truncated,
            };
        }),
    create: organizationAdminProcedure
        .input(v.object({ name, ...accountInput }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const result = await verifyAccount(input);
            const connectionId = randomUUID();

            const [connection] = await db
                .insert(gitConnections)
                .values({
                    id: connectionId,
                    organizationId,
                    name: input.name,
                    provider: input.provider,
                    serverUrl: result.serverUrl,
                    authType: "token",
                    account: result.account,
                    repositories: result.repositories,
                    encryptedCredentials: Object.values(result.credentials).some(Boolean)
                        ? encryptGitCredentials(result.credentials, {
                              organizationId,
                              connectionId,
                          })
                        : null,
                })
                .returning();

            return publicConnection(connection!);
        }),
    update: organizationAdminProcedure
        .input(
            v.object({
                connectionId: id,
                name,
                credentials: v.optional(credentialsInput),
                repositories: repositoriesInput,
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const { connection, credentials } = await db.transaction((tx) =>
                accountConnection(tx, organizationId, input.connectionId, input.credentials),
            );

            const result = await verifyAccount({
                ...connection,
                credentials,
                repositories: input.repositories ?? connection.repositories,
            });

            const [updated] = await db
                .update(gitConnections)
                .set({
                    name: input.name,
                    account: result.account,
                    repositories: result.repositories,
                    authType: input.credentials !== undefined ? "token" : connection.authType,
                    encryptedCredentials: Object.values(result.credentials).some(Boolean)
                        ? encryptGitCredentials(result.credentials, {
                              organizationId,
                              connectionId: connection.id,
                          })
                        : null,
                })
                .where(
                    and(
                        eq(gitConnections.id, connection.id),
                        eq(gitConnections.updatedAt, connection.updatedAt),
                        sql`${gitConnections.encryptedCredentials} is not distinct from ${connection.encryptedCredentials}`,
                    ),
                )
                .returning();

            if (!updated)
                throw new ORPCError("CONFLICT", {
                    message: "This connection changed. Reload before saving.",
                });

            return publicConnection(updated);
        }),
    delete: organizationAdminProcedure
        .input(v.object({ connectionId: id }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [connection] = await tx
                    .select({ id: gitConnections.id })
                    .from(gitConnections)
                    .where(
                        and(
                            eq(gitConnections.id, input.connectionId),
                            eq(gitConnections.organizationId, organizationId),
                        ),
                    )
                    .for("update");

                if (!connection)
                    throw new ORPCError("NOT_FOUND", { message: "Git connection not found." });

                const [used] = await tx
                    .select({ id: resources.id })
                    .from(resources)
                    .where(eq(resources.gitConnectionId, connection.id))
                    .limit(1);

                if (used)
                    throw new ORPCError("CONFLICT", {
                        message:
                            "Detach this connection from its Compose resources before deleting it.",
                    });
                await tx.delete(gitConnections).where(eq(gitConnections.id, connection.id));

                return { success: true };
            }),
        ),
    getRepositories: organizationProcedure
        .input(v.object({ connectionId: id }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const { connection, credentials } = await db.transaction((tx) =>
                accountConnection(tx, organizationId, input.connectionId),
            );

            return repositoriesFor(connection, credentials);
        }),
    listFiles: organizationProcedure
        .input(v.object({ connectionId: id, repositoryUrl: url, branch }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            listGitFiles(
                await getGitConnection(
                    db,
                    organizationId,
                    input.connectionId,
                    input.repositoryUrl,
                    input.branch,
                ),
            ),
        ),
    readFile: organizationProcedure
        .input(v.object({ connectionId: id, repositoryUrl: url, branch, path: gitFilePath }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            readGitFile(
                await getGitConnection(
                    db,
                    organizationId,
                    input.connectionId,
                    input.repositoryUrl,
                    input.branch,
                ),
                input.path,
            ),
        ),
    pushFile: organizationAdminProcedure
        .input(
            v.object({
                connectionId: id,
                repositoryUrl: url,
                branch,
                path: gitFilePath,
                content: gitText,
                expectedRevision: gitRevision,
                message: gitMessage,
            }),
        )
        .handler(async ({ context: { db, organizationId, session }, input }) =>
            pushGitFile(
                await getGitConnection(
                    db,
                    organizationId,
                    input.connectionId,
                    input.repositoryUrl,
                    input.branch,
                ),
                { ...input, author: { name: session.user.name, email: session.user.email } },
            ),
        ),
};
