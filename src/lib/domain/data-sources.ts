import * as v from "valibot";

/**
 * Authentication mechanisms supported by a Git Source.
 *
 * `none` is useful for public repositories, while the remaining methods keep
 * credentials out of the repository URL stored on a data source.
 */
export const GIT_AUTH_METHODS = ["none", "token", "basic", "ssh"] as const;

export type GitAuthMethod = (typeof GIT_AUTH_METHODS)[number];

export const GitAuthMethodSchema = v.picklist(GIT_AUTH_METHODS);

const SecretInput = v.optional(v.nullable(v.string()));

/** Input accepted when creating a Git Source. */
export const CreateGitSourceInput = v.object({
    authMethod: v.optional(GitAuthMethodSchema, "none"),
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
    password: SecretInput,
    sshKnownHosts: SecretInput,
    sshPassphrase: SecretInput,
    sshPrivateKey: SecretInput,
    token: SecretInput,
    url: v.pipe(v.string(), v.trim(), v.minLength(1)),
    username: SecretInput,
});

/** Input accepted when updating a Git Source. Omitted secrets are retained. */
export const UpdateGitSourceInput = v.object({
    authMethod: v.optional(GitAuthMethodSchema),
    id: v.pipe(v.string(), v.trim(), v.minLength(1)),
    name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
    password: SecretInput,
    sshKnownHosts: SecretInput,
    sshPassphrase: SecretInput,
    sshPrivateKey: SecretInput,
    token: SecretInput,
    url: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    username: SecretInput,
});

export type CreateGitSourceInputOutput = v.InferOutput<typeof CreateGitSourceInput>;
export type UpdateGitSourceInputOutput = v.InferOutput<typeof UpdateGitSourceInput>;

/** A safe Git Source representation suitable for sending to the browser. */
export interface GitSourceSummary {
    authMethod: GitAuthMethod;
    hasPassword: boolean;
    hasPrivateKey: boolean;
    hasToken: boolean;
    id: string;
    name: string;
    sshKnownHostsConfigured: boolean;
    url: string | null;
    username: string | null;
}

/** Server-only Git Source credentials. Never return this type from a remote query. */
export interface GitSourceConnection extends GitSourceSummary {
    organizationId: string;
    password: string | null;
    sshKnownHosts: string | null;
    sshPassphrase: string | null;
    sshPrivateKey: string | null;
    token: string | null;
}

export const gitSourceSummary = ({
    authMethod,
    id,
    name,
    organizationId: _organizationId,
    password,
    sshKnownHosts,
    sshPassphrase: _sshPassphrase,
    sshPrivateKey,
    token,
    url,
    username,
}: GitSourceConnection): GitSourceSummary => ({
    authMethod,
    hasPassword: Boolean(password),
    hasPrivateKey: Boolean(sshPrivateKey),
    hasToken: Boolean(token),
    id,
    name,
    sshKnownHostsConfigured: Boolean(sshKnownHosts),
    url,
    username,
});

export const gitSourceLabel = (source: Pick<GitSourceSummary, "name" | "url">): string =>
    source.name || source.url || "Git Source";
