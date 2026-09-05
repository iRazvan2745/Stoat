import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GitAuthMethod } from "#lib/domain/data-sources";

/**
 * Git authentication is deliberately kept separate from a repository URL.
 *
 * A Git source may be shared by several data sources, while its secret must
 * remain server-only.  Do not add secret fields to any type returned by a
 * remote function.
 */
export { GIT_AUTH_METHODS } from "#lib/domain/data-sources";

export interface NoGitAuthentication {
    method: "none";
}

export interface HttpsGitAuthentication {
    method: "basic" | "token";
    password?: string;
    token?: string;
    username?: string;
}

export interface SshGitAuthentication {
    knownHosts?: string;
    method: "ssh";
    passphrase?: string;
    privateKey?: string;
    username?: string;
}

export type GitAuthentication = NoGitAuthentication | HttpsGitAuthentication | SshGitAuthentication;

export interface GitSourceAuthenticationRecord {
    authMethod: GitAuthMethod;
    password?: string | null;
    sshKnownHosts?: string | null;
    sshPassphrase?: string | null;
    sshPrivateKey?: string | null;
    token?: string | null;
    username?: string | null;
}

export interface GitUrlDetails {
    hasEmbeddedCredentials: boolean;
    host: string;
    path: string;
    protocol: "git" | "http" | "https" | "scp" | "ssh";
    url: string;
}

export interface GitAuthenticationEnvironment {
    cleanup: () => Promise<void>;
    env: Record<string, string>;
}

export interface ValidatedGitSource {
    authentication: GitAuthentication;
    details: GitUrlDetails;
    url: string;
}

// oxlint-disable-next-line no-control-regex -- Git URLs must reject every ASCII control byte.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const SCP_URL_PATTERN = /^(?:([^/@:\s]+)@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/u;
const URL_SENSITIVE_PARAMETER_PATTERN = /(?:auth|credential|key|pass(?:word)?|secret|token)/iu;
const PRIVATE_KEY_HEADER_PATTERN = /^-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/u;

const emptyAuthentication = (): NoGitAuthentication => ({ method: "none" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const nonEmptyString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeMethod = (value: unknown): GitAuthMethod => {
    if (value === undefined || value === null || value === "") {
        return "none";
    }

    if (value === "none" || value === "token" || value === "basic" || value === "ssh") {
        return value;
    }

    // Accept the old single HTTPS mode at the server boundary while storing
    // the more explicit token/basic mode used by Git Sources.
    if (value === "https") {
        throw new Error("HTTPS Git authentication must specify token or basic mode");
    }

    throw new Error("Git authentication method must be none, token, basic, or ssh");
};

/**
 * Validates and normalizes credentials before they are persisted or used by
 * Git.  This function accepts unknown input intentionally so it can be used at
 * the server boundary without trusting a client-side type assertion.
 */
export const validateGitAuthentication = (input?: unknown): GitAuthentication => {
    if (!isRecord(input)) {
        if (input === undefined || input === null) {
            return emptyAuthentication();
        }

        throw new Error("Git authentication must be an object");
    }

    const method = normalizeMethod(input.method ?? input.type);

    if (method === "none") {
        return emptyAuthentication();
    }

    if (method === "token" || method === "basic") {
        const token = nonEmptyString(input.token);
        const password = nonEmptyString(input.password);

        if (token && password) {
            throw new Error("HTTPS Git authentication accepts a token or password, not both");
        }

        if (method === "token" && !token) {
            throw new Error("Token Git authentication requires a token");
        }

        if (method === "basic" && (!password || !nonEmptyString(input.username))) {
            throw new Error("Basic Git authentication requires a username and password");
        }

        if (method === "token" && password) {
            throw new Error("Token Git authentication cannot include a password");
        }

        if (method === "basic" && token) {
            throw new Error("Basic Git authentication cannot include a token");
        }

        return {
            ...(method === "basic" ? { password } : { token }),
            method,
            ...(nonEmptyString(input.username) ? { username: nonEmptyString(input.username) } : {}),
        };
    }

    const privateKey = nonEmptyString(input.privateKey);

    // An SSH agent is a supported deployment configuration.  In that case a
    // private key is intentionally omitted and git uses SSH_AUTH_SOCK.
    if (privateKey && !PRIVATE_KEY_HEADER_PATTERN.test(privateKey)) {
        throw new Error("SSH private key must be a PEM or OpenSSH private key");
    }

    const passphrase = nonEmptyString(input.passphrase);

    if (passphrase && !privateKey) {
        throw new Error("An SSH passphrase requires a private key");
    }

    const knownHosts = nonEmptyString(input.knownHosts);

    return {
        method,
        ...(knownHosts ? { knownHosts } : {}),
        ...(passphrase ? { passphrase } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(nonEmptyString(input.username) ? { username: nonEmptyString(input.username) } : {}),
    };
};

/** Converts the server-only Git Source row into credentials for Git. */
export const gitAuthenticationFromSource = (
    source: GitSourceAuthenticationRecord,
): GitAuthentication =>
    validateGitAuthentication({
        knownHosts: source.sshKnownHosts,
        method: source.authMethod,
        passphrase: source.sshPassphrase,
        password: source.password,
        privateKey: source.sshPrivateKey,
        token: source.token,
        username: source.username,
    });

const parseGitUrl = (value: string): GitUrlDetails => {
    const url = value.trim();

    if (!url || CONTROL_CHARACTER_PATTERN.test(url)) {
        throw new Error("Git URL must be a non-empty URL");
    }

    const scpMatch = SCP_URL_PATTERN.exec(url);

    if (scpMatch && !url.includes("://")) {
        const [, , host, repositoryPath] = scpMatch;

        if (!host || !repositoryPath || repositoryPath === "/") {
            throw new Error("Git URL must include a repository path");
        }

        return {
            // In SCP-style Git URLs, `git@host` is the SSH transport user,
            // not URL userinfo containing a secret.
            hasEmbeddedCredentials: false,
            host,
            path: repositoryPath,
            protocol: "scp",
            url,
        };
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new Error("Git URL must use HTTPS, SSH, git, or SCP syntax");
    }

    const protocol = parsed.protocol.slice(0, -1);

    if (protocol !== "git" && protocol !== "http" && protocol !== "https" && protocol !== "ssh") {
        throw new Error("Git URL must use HTTPS, SSH, git, or SCP syntax");
    }

    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
        throw new Error("Git URL must include a host and repository path");
    }

    return {
        hasEmbeddedCredentials: parsed.username !== "" || parsed.password !== "",
        host: parsed.host,
        path: parsed.pathname,
        protocol: protocol as GitUrlDetails["protocol"],
        url,
    };
};

/** Validates the URL syntax and returns a small, safe-to-log description. */
export const validateGitUrl = (value: unknown): GitUrlDetails => {
    if (typeof value !== "string") {
        throw new TypeError("Git URL must be a string");
    }

    return parseGitUrl(value);
};

/**
 * Validates the URL/authentication pairing used by a Git Source and returns
 * the credential-free URL that should be persisted. HTTPS secrets are only
 * allowed over HTTPS; SSH credentials require SSH or SCP transport.
 */
export const validateGitSource = (input: {
    authentication: unknown;
    url: unknown;
}): ValidatedGitSource => {
    const details = validateGitUrl(input.url);
    const authentication = validateGitAuthentication(input.authentication);

    if (authentication.method === "token" || authentication.method === "basic") {
        if (details.protocol !== "https") {
            throw new Error("Token and basic Git authentication require an HTTPS URL");
        }

        if (details.hasEmbeddedCredentials) {
            throw new Error(
                "Git URL must not contain credentials; enter them in the authentication fields",
            );
        }
    }

    if (
        authentication.method === "ssh" &&
        details.protocol !== "ssh" &&
        details.protocol !== "scp"
    ) {
        throw new Error("SSH Git authentication requires an SSH or SCP URL");
    }

    if (authentication.method === "none" && details.hasEmbeddedCredentials) {
        throw new Error("Git URL contains credentials; choose an authentication method instead");
    }

    return {
        authentication,
        details,
        url: removeGitUrlCredentials(details.url),
    };
};

const removeSensitiveSearchParameters = (parsed: URL): void => {
    const sensitiveKeys: string[] = [];

    for (const key of parsed.searchParams.keys()) {
        if (URL_SENSITIVE_PARAMETER_PATTERN.test(key)) {
            sensitiveKeys.push(key);
        }
    }

    for (const key of sensitiveKeys) {
        parsed.searchParams.delete(key);
    }
};

/**
 * Removes URL credentials and sensitive query parameters before a URL is
 * stored or passed to a child process.  SSH's `git@host:path` user is a
 * transport selector rather than a secret, so SCP syntax is preserved.
 */
export const removeGitUrlCredentials = (value: string): string => {
    const url = value.trim();

    // `new URL` treats the first component of `user:password@host:path` as
    // a custom scheme, so strip credential-bearing SCP syntax explicitly.
    const scpCredentials = /^(?:[^/@:\s]+):[^/@\s]+@(.+)$/u.exec(url);
    if (scpCredentials?.[1]) {
        return scpCredentials[1];
    }

    try {
        const parsed = new URL(url);
        // SSH URLs need their transport user (normally `git`) to remain in
        // the remote; only an SSH password is ever a credential. HTTPS/Git
        // userinfo is removed completely because usernames can be tokens.
        if (parsed.protocol !== "ssh:") {
            parsed.username = "";
        }
        parsed.password = "";
        parsed.hash = "";
        removeSensitiveSearchParameters(parsed);
        return parsed.toString();
    } catch {
        const withoutCredentials = url.replace(/\/\/[^/@\s]+(?::[^/@\s]*)?@/u, "//");
        return withoutCredentials
            .replace(/^[^/@:\s]+:[^/@\s]+@/u, "")
            .replaceAll(
                /([?&])[^=&#\s]*(?:token|secret|password|key|auth)[^=&#\s]*=[^&#\s]*/giu,
                "$1",
            )
            .replace(/[?&]$/u, "");
    }
};

/** Returns a log-safe URL while retaining the fact that userinfo existed. */
export const redactGitUrl = (value: string): string => {
    const url = value.trim();

    const scpCredentials = /^(?:[^/@:\s]+):[^/@\s]+@(.+)$/u.exec(url);
    if (scpCredentials?.[1]) {
        return `***@${scpCredentials[1]}`;
    }

    try {
        const parsed = new URL(url);
        const hadCredentials = parsed.username !== "" || parsed.password !== "";

        if (hadCredentials) {
            parsed.username = "***";
            parsed.password = "";
        }

        parsed.hash = "";
        for (const key of parsed.searchParams.keys()) {
            if (URL_SENSITIVE_PARAMETER_PATTERN.test(key)) {
                parsed.searchParams.set(key, "[REDACTED]");
            }
        }

        return parsed.toString();
    } catch {
        return url
            .replace(/\/\/[^/@\s]+(?::[^/@\s]*)?@/u, "//***@")
            .replaceAll(
                /([?&][^=&#\s]*(?:token|secret|password|key|auth)[^=&#\s]*=)[^&#\s]*/giu,
                "$1[REDACTED]",
            );
    }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const base64UrlEncode = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

const base64UrlDecode = (value: string): Uint8Array => Buffer.from(value, "base64url");

const deriveEncryptionKey = async (secret: string): Promise<CryptoKey> => {
    if (!secret.trim()) {
        throw new Error("Git credential encryption key must not be empty");
    }

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
};

/**
 * Encrypts the secret-bearing part of a Git source for database storage.
 * Callers should use APP_SECRET as `encryptionSecret`; this helper does not
 * import environment variables so it remains easy to test and rotate.
 */
export const encryptGitAuthentication = async (
    authentication: GitAuthentication,
    encryptionSecret: string,
): Promise<string> => {
    const normalized = validateGitAuthentication(authentication);
    const key = await deriveEncryptionKey(encryptionSecret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(normalized));
    const ciphertext = await crypto.subtle.encrypt(
        { iv: iv as BufferSource, name: "AES-GCM" },
        key,
        plaintext as BufferSource,
    );

    return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
};

/** Decrypts and validates a database value created by encryptGitAuthentication. */
export const decryptGitAuthentication = async (
    encrypted: string,
    encryptionSecret: string,
): Promise<GitAuthentication> => {
    const [version, encodedIv, encodedCiphertext] = encrypted.split(".");

    if (version !== "v1" || !encodedIv || !encodedCiphertext) {
        throw new Error("Unsupported encrypted Git credentials");
    }

    try {
        const key = await deriveEncryptionKey(encryptionSecret);
        const plaintext = await crypto.subtle.decrypt(
            { iv: base64UrlDecode(encodedIv) as BufferSource, name: "AES-GCM" },
            key,
            base64UrlDecode(encodedCiphertext) as BufferSource,
        );
        const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
        return validateGitAuthentication(value);
    } catch (error) {
        if (error instanceof Error && error.message === "Unsupported encrypted Git credentials") {
            throw error;
        }

        throw new Error("Unable to decrypt Git credentials", { cause: error });
    }
};

/**
 * Produces a safe representation for list/detail responses.  Secret values
 * are intentionally represented only by booleans; never spread the original
 * authentication object into a remote response.
 */
export const redactGitAuthentication = (
    authentication: GitAuthentication,
): {
    hasCredentials: boolean;
    method: GitAuthMethod;
    username: string | null;
} => {
    const normalized = validateGitAuthentication(authentication);

    return {
        hasCredentials:
            normalized.method === "token" || normalized.method === "basic"
                ? Boolean(normalized.token || normalized.password)
                : normalized.method === "ssh"
                  ? Boolean(normalized.privateKey) || Boolean(process.env.SSH_AUTH_SOCK)
                  : false,
        method: normalized.method,
        username:
            normalized.method === "token" ||
            normalized.method === "basic" ||
            normalized.method === "ssh"
                ? (normalized.username ?? null)
                : null,
    };
};

const authenticationUrl = (url: string, authentication: GitAuthentication): string => {
    const cleanUrl = removeGitUrlCredentials(url);

    if (authentication.method !== "ssh" || !authentication.username) {
        return cleanUrl;
    }

    try {
        const parsed = new URL(cleanUrl);

        if (parsed.protocol !== "ssh:") {
            return cleanUrl;
        }

        if (!parsed.username) {
            parsed.username = authentication.username;
        }

        return parsed.toString();
    } catch {
        const match = SCP_URL_PATTERN.exec(cleanUrl);

        if (match && !match[1]) {
            return `${authentication.username}@${match[2]}:${match[3]}`;
        }

        return cleanUrl;
    }
};

/**
 * Builds child-process-only Git credentials.  HTTPS secrets are passed as a
 * Git config environment value instead of URL userinfo or command arguments.
 * SSH keys are written with mode 0600 and removed by cleanup.
 */
export const createGitAuthenticationEnvironment = async (
    authentication: GitAuthentication,
): Promise<GitAuthenticationEnvironment> => {
    const normalized = validateGitAuthentication(authentication);

    if (normalized.method === "none") {
        return { cleanup: async () => {}, env: { GIT_TERMINAL_PROMPT: "0" } };
    }

    if (normalized.method === "token" || normalized.method === "basic") {
        const secret = normalized.token ?? normalized.password;
        if (!secret) {
            throw new Error("HTTPS Git authentication requires a token or password");
        }

        const username = normalized.username ?? (normalized.token ? "oauth2" : "git");
        const encoded = Buffer.from(`${username}:${secret}`, "utf-8").toString("base64");

        return {
            cleanup: async () => {},
            env: {
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.extraHeader",
                GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
                GIT_TERMINAL_PROMPT: "0",
            },
        };
    }

    // GitAuthMethod comes from the shared domain schema, so narrow explicitly
    // before accessing SSH-only fields.
    if (normalized.method !== "ssh") {
        throw new Error("Unsupported Git authentication method");
    }

    const sshAuthentication = normalized as SshGitAuthentication;

    if (sshAuthentication.passphrase) {
        throw new Error(
            "Passphrase-protected SSH keys require an SSH agent; configure SSH_AUTH_SOCK or use an agent-backed key",
        );
    }

    if (!sshAuthentication.privateKey) {
        return {
            cleanup: async () => {},
            env: { GIT_TERMINAL_PROMPT: "0" },
        };
    }

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "stoat-git-"));
    const privateKeyPath = path.join(temporaryDirectory, "id_git");
    const knownHostsPath = sshAuthentication.knownHosts
        ? path.join(temporaryDirectory, "known_hosts")
        : undefined;

    try {
        await writeFile(privateKeyPath, `${sshAuthentication.privateKey.trimEnd()}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });

        if (knownHostsPath && sshAuthentication.knownHosts) {
            await writeFile(knownHostsPath, `${sshAuthentication.knownHosts.trimEnd()}\n`, {
                encoding: "utf-8",
                mode: 0o600,
            });
        }
    } catch (error) {
        await rm(temporaryDirectory, { force: true, recursive: true });
        throw error;
    }

    const sshArguments = [
        `-i ${shellQuote(privateKeyPath)}`,
        "-o IdentitiesOnly=yes",
        "-o BatchMode=yes",
        ...(knownHostsPath
            ? [
                  `-o UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
                  "-o StrictHostKeyChecking=yes",
              ]
            : []),
    ];

    return {
        cleanup: async () => {
            await rm(temporaryDirectory, { force: true, recursive: true });
        },
        env: {
            GIT_SSH_COMMAND: `ssh ${sshArguments.join(" ")}`,
            GIT_TERMINAL_PROMPT: "0",
        },
    };
};

export const gitUrlForAuthentication = authenticationUrl;
