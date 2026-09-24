import {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";
import type { Database } from "@stoat/db";
import { getOrganizationMembership } from "@stoat/db/organizations";
import { gitConnections, gitOAuthProviders, member } from "@stoat/db/schema/index";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Context } from "./context";
import type { GitCredentials } from "./git";
import {
    getGitAccount,
    gitProviderRequest,
    listGitRepositories,
    validateGitServerUrl,
} from "./git-provider";
import { encryptGitCredentials } from "./git-secrets";
import { decryptGitOAuthClientSecret, encryptGitOAuthClientSecret } from "./git-oauth-secrets";

const providerSchema = z
    .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        name: z.string().trim().min(1).max(100),
        provider: z.enum(["github", "forgejo"]),
        serverUrl: z.string().min(1).max(2048),
        clientId: z.string().trim().min(1).max(2048),
        clientSecret: z.string().min(1).max(8192),
    })
    .strict();

export type GitOAuthProvider = z.infer<typeof providerSchema>;

export type GitOAuthIdentity = { userId: string; sessionId: string; organizationId: string };

type ErrorCode =
    | "configuration"
    | "forbidden"
    | "invalid_request"
    | "invalid_state"
    | "connection_mismatch"
    | "token_exchange_failed"
    | "invalid_token"
    | "account_failed";

export class GitOAuthError extends Error {
    constructor(
        public readonly code: ErrorCode,
        message: string = code,
    ) {
        super(message);
        this.name = "GitOAuthError";
    }
}

/** Server-only configuration. Never serialize this result to a browser. */
export function getGitOAuthProviders(): GitOAuthProvider[] {
    const raw = process.env.GIT_OAUTH_PROVIDERS;

    if (!raw) return [];

    try {
        if (raw.length > 128 * 1024) throw new Error();
        const providers = z.array(providerSchema).max(32).parse(JSON.parse(raw));

        // Stored apps have a reserved namespace and can never shadow a global app.
        if (providers.some((provider) => provider.id.startsWith("db_"))) throw new Error();

        if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
            throw new Error();

        return providers.map((provider) => ({
            ...provider,
            serverUrl: validateGitServerUrl(provider.serverUrl, provider.provider),
        }));
    } catch {
        throw new GitOAuthError(
            "configuration",
            "Set GIT_OAUTH_PROVIDERS to a JSON array of unique id, name, provider (github/forgejo), serverUrl, clientId and clientSecret configurations.",
        );
    }
}

export function getPublicGitOAuthProviders() {
    return getGitOAuthProviders().map(({ id, name, provider, serverUrl }) => ({
        id,
        name,
        provider,
        serverUrl,
    }));
}

const publicProviderColumns = {
    id: gitOAuthProviders.id,
    name: gitOAuthProviders.name,
    provider: gitOAuthProviders.provider,
    serverUrl: gitOAuthProviders.serverUrl,
};

export async function getPublicOrganizationGitOAuthProviders(
    db: Pick<Database, "select">,
    organizationId: string,
) {
    try {
        const stored = await db
            .select(publicProviderColumns)
            .from(gitOAuthProviders)
            .where(
                and(
                    eq(gitOAuthProviders.organizationId, organizationId),
                    eq(gitOAuthProviders.active, true),
                ),
            )
            .orderBy(asc(gitOAuthProviders.name));

        return [...getPublicGitOAuthProviders(), ...stored];
    } catch {
        throw new GitOAuthError("configuration", "Unable to load Git OAuth applications.");
    }
}

/** Server-only. Resolve apps exclusively within the caller's authorized organization. */
export async function getOrganizationGitOAuthProviders(
    db: Pick<Database, "select">,
    organizationId: string,
): Promise<GitOAuthProvider[]> {
    try {
        const stored = await db
            .select()
            .from(gitOAuthProviders)
            .where(
                and(
                    eq(gitOAuthProviders.organizationId, organizationId),
                    eq(gitOAuthProviders.active, true),
                ),
            )
            .orderBy(asc(gitOAuthProviders.name));

        return [
            ...getGitOAuthProviders(),
            ...stored.map((row) => {
                const provider = providerSchema.parse({
                    id: row.id,
                    name: row.name,
                    provider: row.provider,
                    serverUrl: validateGitServerUrl(row.serverUrl, row.provider),
                    clientId: row.clientId,
                    clientSecret: decryptGitOAuthClientSecret(row.encryptedClientSecret, row),
                });

                if (!provider.id.startsWith("db_") || row.organizationId !== organizationId)
                    throw new Error();

                return provider;
            }),
        ];
    } catch {
        throw new GitOAuthError("configuration", "Unable to load Git OAuth applications.");
    }
}

export async function createOrganizationGitOAuthProvider(
    db: Database,
    identity: Pick<GitOAuthIdentity, "userId" | "organizationId">,
    input: Omit<GitOAuthProvider, "id">,
) {
    let provider: GitOAuthProvider;

    try {
        provider = providerSchema.parse({ ...input, id: `db_${randomUUID()}` });
        provider.serverUrl = validateGitServerUrl(provider.serverUrl, provider.provider);
    } catch {
        throw new GitOAuthError("invalid_request", "Invalid Git OAuth application configuration.");
    }

    try {
        await db.transaction(async (tx) => {
            const [membership] = await tx
                .select()
                .from(member)
                .where(
                    and(
                        eq(member.userId, identity.userId),
                        eq(member.organizationId, identity.organizationId),
                    ),
                )
                .for("share");

            if (
                !membership?.role
                    .split(",")
                    .some((role) => ["owner", "admin"].includes(role.trim()))
            )
                throw new GitOAuthError("forbidden");
            const { clientSecret, ...configuration } = provider;
            await tx.insert(gitOAuthProviders).values({
                ...configuration,
                organizationId: identity.organizationId,
                encryptedClientSecret: encryptGitOAuthClientSecret(clientSecret, {
                    ...configuration,
                    organizationId: identity.organizationId,
                }),
            });
        });
    } catch (error) {
        if (error instanceof GitOAuthError && error.code === "forbidden") throw error;
        // SQL errors can include query parameters. Never propagate them or their causes.
        throw new GitOAuthError("configuration", "Unable to save Git OAuth application.");
    }

    const { id, name, provider: kind, serverUrl } = provider;

    return { id, name, provider: kind, serverUrl };
}

export function getGitOAuthCallbackUrl(): string {
    try {
        const raw = process.env.BETTER_AUTH_URL;

        if (!raw || raw.length > 2048) throw new Error();
        const url = new URL(raw);

        if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== "https:" &&
                !(
                    url.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                ))
        )
            throw new Error();
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/git/oauth/callback`;

        return url.href;
    } catch {
        throw new GitOAuthError(
            "configuration",
            "Set BETTER_AUTH_URL to the trusted HTTPS application base URL and register that URL plus /git/oauth/callback with your Git OAuth application.",
        );
    }
}

export function assertGitOAuthOrigin(request: Request): void {
    const trustedOrigin = new URL(getGitOAuthCallbackUrl()).origin;

    if (
        request.method !== "POST" ||
        request.headers.get("origin") !== trustedOrigin ||
        new URL(request.url).origin !== trustedOrigin
    )
        throw new GitOAuthError("forbidden");
}

export async function requireGitOAuthAdmin(
    db: Database,
    session: Context["session"],
): Promise<GitOAuthIdentity> {
    const organizationId = session?.session.activeOrganizationId;

    if (!session || !organizationId) throw new GitOAuthError("forbidden");
    const membership = await getOrganizationMembership(db, session.user.id, organizationId);

    if (!membership?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
        throw new GitOAuthError("forbidden");
    }

    return { userId: session.user.id, sessionId: session.session.id, organizationId };
}

export function assertGitOAuthConnection(
    connection: { organizationId: string; provider: string; serverUrl: string } | undefined,
    organizationId: string,
    provider: GitOAuthProvider,
): void {
    if (
        !connection ||
        connection.organizationId !== organizationId ||
        connection.provider !== provider.provider ||
        connection.serverUrl !== provider.serverUrl
    ) {
        throw new GitOAuthError("connection_mismatch");
    }
}

export async function getGitOAuthConnection(
    db: Database,
    organizationId: string,
    connectionId: string,
    provider: GitOAuthProvider,
) {
    if (!z.string().uuid().safeParse(connectionId).success)
        throw new GitOAuthError("invalid_request");

    const [connection] = await db
        .select()
        .from(gitConnections)
        .where(
            and(
                eq(gitConnections.id, connectionId),
                eq(gitConnections.organizationId, organizationId),
            ),
        )
        .limit(1);

    assertGitOAuthConnection(connection, organizationId, provider);

    return connection!;
}

export async function saveGitOAuthConnection(
    db: Database,
    flow: GitOAuthFlow,
    result: Awaited<ReturnType<typeof exchangeGitOAuthCode>>,
): Promise<void> {
    const { provider, account, credentials } = result;
    const connectionId = flow.connectionId ?? randomUUID();
    await db.transaction(async (tx) => {
        // Hold the membership through the write so a concurrent role change cannot authorize it.
        const [membership] = await tx
            .select()
            .from(member)
            .where(
                and(eq(member.userId, flow.userId), eq(member.organizationId, flow.organizationId)),
            )
            .for("share");

        if (!membership?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim())))
            throw new GitOAuthError("forbidden");

        const encryptedCredentials = encryptGitCredentials(credentials, {
            organizationId: flow.organizationId,
            connectionId,
        });

        if (flow.connectionId) {
            const [connection] = await tx
                .select()
                .from(gitConnections)
                .where(
                    and(
                        eq(gitConnections.id, connectionId),
                        eq(gitConnections.organizationId, flow.organizationId),
                    ),
                )
                .for("update");

            assertGitOAuthConnection(connection, flow.organizationId, provider);
            await tx
                .update(gitConnections)
                .set({
                    name: flow.name,
                    authType: "oauth",
                    account,
                    encryptedCredentials,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(gitConnections.id, connectionId),
                        eq(gitConnections.organizationId, flow.organizationId),
                        eq(gitConnections.provider, provider.provider),
                        eq(gitConnections.serverUrl, provider.serverUrl),
                    ),
                );
        } else {
            await tx.insert(gitConnections).values({
                id: connectionId,
                organizationId: flow.organizationId,
                name: flow.name,
                provider: provider.provider,
                serverUrl: provider.serverUrl,
                authType: "oauth",
                account,
                repositories: [],
                encryptedCredentials,
            });
        }
    });
}

export const gitOAuthCookieName = "__Host-stoat-git-oauth";

export const gitOAuthCookieOptions = {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 600,
};

export function getGitOAuthCookieConfig() {
    // Only the validated, explicitly configured HTTP loopback URL permits an insecure cookie.
    const secure = new URL(getGitOAuthCallbackUrl()).protocol === "https:";

    return {
        name: secure ? gitOAuthCookieName : "stoat-git-oauth",
        options: { ...gitOAuthCookieOptions, secure },
    };
}

const domain = "stoat/git-oauth-state/v1";

const flowSchema = z
    .object({
        userId: z.string().min(1).max(256),
        sessionId: z.string().min(1).max(256),
        organizationId: z.string().min(1).max(256),
        providerId: providerSchema.shape.id,
        providerFingerprint: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
        name: z.string().trim().min(1).max(100),
        connectionId: z.string().uuid().optional(),
        state: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
        verifier: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
        createdAt: z.number().int(),
        expiresAt: z.number().int(),
    })
    .strict();

export type GitOAuthFlow = z.infer<typeof flowSchema>;

function fingerprint(provider: GitOAuthProvider): string {
    return createHash("sha256")
        .update(
            JSON.stringify([provider.id, provider.provider, provider.serverUrl, provider.clientId]),
        )
        .digest("base64url");
}

function stateKey(salt: Buffer, identity: GitOAuthIdentity) {
    const secret = process.env.BETTER_AUTH_SECRET;

    if (!secret || Buffer.byteLength(secret) < 32) {
        throw new GitOAuthError(
            "configuration",
            "Set BETTER_AUTH_SECRET to at least 32 bytes for encrypted Git OAuth state.",
        );
    }

    const context = Buffer.from(
        JSON.stringify([
            domain,
            getGitOAuthCallbackUrl(),
            identity.userId,
            identity.sessionId,
            identity.organizationId,
        ]),
    );

    return { key: hkdfSync("sha256", secret, salt, domain, 32), context };
}

export function createGitOAuthFlow(
    input: GitOAuthIdentity & {
        providerId: string;
        name: string;
        connectionId?: string;
    },
    providers: GitOAuthProvider[] = getGitOAuthProviders(),
) {
    const provider = providers.find((entry) => entry.id === input.providerId);

    if (!provider)
        throw new GitOAuthError(
            "configuration",
            "Configure the selected Git OAuth application or reconnect the Git account.",
        );
    const now = Date.now();

    const result = flowSchema.safeParse({
        ...input,
        providerFingerprint: fingerprint(provider),
        state: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        createdAt: now,
        expiresAt: now + gitOAuthCookieOptions.maxAge * 1000,
    });

    if (!result.success) throw new GitOAuthError("invalid_request");
    const flow = result.data;
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    const { key, context } = stateKey(salt, flow);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(context);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(flow)), cipher.final()]);

    const cookie = `v1.${[salt, nonce, cipher.getAuthTag(), encrypted]
        .map((part) => part.toString("base64url"))
        .join(".")}`;

    if (cookie.length > 3800) throw new GitOAuthError("invalid_request");
    const url = new URL(`${provider.serverUrl.replace(/\/+$/, "")}/login/oauth/authorize`);
    url.search = new URLSearchParams({
        client_id: provider.clientId,
        redirect_uri: getGitOAuthCallbackUrl(),
        response_type: "code",
        state: flow.state,
        code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
        code_challenge_method: "S256",
    }).toString();

    // Forgejo does not implement granular OAuth scopes.
    if (provider.provider === "github") url.searchParams.set("scope", "repo read:user");

    return { authorizationUrl: url.href, cookie };
}

export function readGitOAuthFlow(
    cookie: string | undefined,
    state: string | null,
    identity: GitOAuthIdentity,
    providers: GitOAuthProvider[] = getGitOAuthProviders(),
): GitOAuthFlow {
    try {
        if (!cookie || cookie.length > 3800 || !state || !/^[a-zA-Z0-9_-]{43}$/.test(state))
            throw new Error();
        const parts = cookie.split(".");

        if (parts.length !== 5 || parts[0] !== "v1") throw new Error();

        const decoded = parts.slice(1).map((part) => {
            const bytes = Buffer.from(part, "base64url");

            if (!part || bytes.toString("base64url") !== part) throw new Error();

            return bytes;
        });

        const [salt, nonce, tag, ciphertext] = decoded;

        if (salt?.length !== 32 || nonce?.length !== 12 || tag?.length !== 16 || !ciphertext)
            throw new Error();
        const { key, context } = stateKey(salt, identity);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(context);
        decipher.setAuthTag(tag);

        const flow = flowSchema.parse(
            JSON.parse(
                Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
            ),
        );

        const now = Date.now();

        if (
            flow.createdAt > now ||
            flow.expiresAt <= now ||
            flow.expiresAt <= flow.createdAt ||
            flow.expiresAt - flow.createdAt > gitOAuthCookieOptions.maxAge * 1000 ||
            flow.userId !== identity.userId ||
            flow.sessionId !== identity.sessionId ||
            flow.organizationId !== identity.organizationId ||
            !timingSafeEqual(Buffer.from(flow.state), Buffer.from(state))
        )
            throw new Error();
        const provider = providers.find((entry) => entry.id === flow.providerId);

        if (!provider || fingerprint(provider) !== flow.providerFingerprint) throw new Error();

        return flow;
    } catch {
        throw new GitOAuthError("invalid_state");
    }
}

const tokenString = z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[\x21-\x7e]+$/);

const tokenSchema = z.object({
    access_token: tokenString,
    token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
    expires_in: z.number().int().positive().optional(),
    refresh_token: tokenString.optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
    error: z.unknown().optional(),
});

async function requestToken(provider: GitOAuthProvider, parameters: Record<string, string>) {
    const requestedAt = Date.now();
    let response: unknown;

    try {
        response = await gitProviderRequest(
            `${provider.serverUrl.replace(/\/+$/, "")}/login/oauth/access_token`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    accept: "application/json",
                },
                body: new URLSearchParams({
                    ...parameters,
                    client_id: provider.clientId,
                    client_secret: provider.clientSecret,
                }).toString(),
            },
        );
    } catch {
        throw new GitOAuthError("token_exchange_failed");
    }

    const parsed = tokenSchema.safeParse(response);

    if (!parsed.success || parsed.data.error !== undefined)
        throw new GitOAuthError("invalid_token");
    const token = parsed.data;

    const expiresAt =
        token.expires_in === undefined ? undefined : requestedAt + token.expires_in * 1000;

    if (
        (expiresAt !== undefined &&
            (!Number.isSafeInteger(expiresAt) ||
                expiresAt > 8.64e15 ||
                expiresAt <= Date.now() + 60_000 ||
                !token.refresh_token)) ||
        (provider.provider !== "github" && expiresAt === undefined) ||
        (token.refresh_token_expires_in !== undefined &&
            requestedAt + token.refresh_token_expires_in * 1000 <= Date.now() + 60_000)
    ) {
        throw new GitOAuthError("invalid_token");
    }

    return {
        password: token.access_token,
        oauthProviderId: provider.id,
        refreshToken: token.refresh_token,
        expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
    };
}

export async function exchangeGitOAuthCode(
    flow: GitOAuthFlow,
    code: string,
    providers: GitOAuthProvider[] = getGitOAuthProviders(),
) {
    const provider = providers.find((entry) => entry.id === flow.providerId);

    if (!provider || fingerprint(provider) !== flow.providerFingerprint)
        throw new GitOAuthError("invalid_state");

    if (!code || code.length > 4096 || /\s/.test(code) || flow.expiresAt <= Date.now())
        throw new GitOAuthError("invalid_request");

    const token = await requestToken(provider, {
        grant_type: "authorization_code",
        code,
        redirect_uri: getGitOAuthCallbackUrl(),
        code_verifier: flow.verifier,
    });

    try {
        const accountInput = {
            provider: provider.provider,
            serverUrl: provider.serverUrl,
            token: token.password,
        };

        const account = await getGitAccount(accountInput);
        await listGitRepositories(accountInput);

        const credentials: GitCredentials = {
            ...token,
            username: provider.provider === "github" ? "x-access-token" : account.login,
        };

        return { provider, account, credentials };
    } catch {
        throw new GitOAuthError("account_failed");
    }
}

/** Caller must check provider/server binding, lock the connection, and persist the replacement before use. */
export async function refreshGitOAuthCredentials(
    credentials: GitCredentials,
    providers: GitOAuthProvider[] = getGitOAuthProviders(),
): Promise<GitCredentials> {
    if (!credentials.oauthProviderId) {
        if (credentials.expiresAt || credentials.refreshToken)
            throw new GitOAuthError("invalid_token");

        return credentials;
    }

    const provider = providers.find((entry) => entry.id === credentials.oauthProviderId);

    if (!provider)
        throw new GitOAuthError(
            "configuration",
            "Restore this connection's OAuth application (GIT_OAUTH_PROVIDERS for global apps) or reconnect the Git account.",
        );

    if (!credentials.expiresAt) {
        if (provider.provider !== "github") throw new GitOAuthError("invalid_token");

        return credentials;
    }

    const expiresAt = Date.parse(credentials.expiresAt);

    if (!Number.isFinite(expiresAt)) throw new GitOAuthError("invalid_token");

    if (expiresAt > Date.now() + 60_000) return credentials;

    if (!credentials.refreshToken) throw new GitOAuthError("invalid_token");

    const replacement = await requestToken(provider, {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
    });

    return { username: credentials.username, ...replacement };
}
