import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";

import type { GitCredentials } from "./git";

type Scope = { organizationId: string; connectionId: string };

const domain = "stoat/git-credentials/v1";

const credentialField = z
    .string()
    .refine((value) => Buffer.byteLength(value) <= 128 * 1024)
    .optional();

const credentialsSchema = z.strictObject({
    username: credentialField,
    password: credentialField,
    privateKey: credentialField,
    knownHosts: credentialField,
    oauthProviderId: credentialField,
    refreshToken: credentialField,
    expiresAt: credentialField,
});

const scopeSchema = z.object({
    organizationId: z.string().min(1).max(1024),
    connectionId: z.string().min(1).max(1024),
});

function keyMaterial(scope: Scope, salt: Buffer) {
    const secret = process.env.BETTER_AUTH_SECRET;

    if (!secret || Buffer.byteLength(secret) < 32) {
        throw new Error("BETTER_AUTH_SECRET must contain at least 32 bytes");
    }

    if (!scopeSchema.safeParse(scope).success) {
        throw new Error("Invalid Git credential scope");
    }

    const context = Buffer.from(JSON.stringify([domain, scope.organizationId, scope.connectionId]));

    return { context, key: hkdfSync("sha256", secret, salt, context, 32) };
}

export function encryptGitCredentials(credentials: GitCredentials, scope: Scope): string {
    const parsed = credentialsSchema.safeParse(credentials);

    if (!parsed.success) throw new Error("Invalid Git credentials");
    const plaintext = Buffer.from(JSON.stringify(parsed.data));

    if (plaintext.length > 512 * 1024) throw new Error("Git credentials exceed storage limits");
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    const { key, context } = keyMaterial(scope, salt);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return `v1.${[salt, nonce, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64url"))
        .join(".")}`;
}

export function decryptGitCredentials(envelope: string, scope: Scope): GitCredentials {
    try {
        if (
            !z
                .string()
                .max(1024 * 1024)
                .safeParse(envelope).success
        )
            throw new Error();
        const parts = envelope.split(".");

        if (parts.length !== 5 || parts[0] !== "v1") throw new Error();

        const decoded = parts.slice(1).map((part) => {
            const bytes = Buffer.from(part, "base64url");

            if (!part || bytes.toString("base64url") !== part) throw new Error();

            return bytes;
        });

        const [salt, nonce, tag, ciphertext] = decoded;

        if (
            !salt ||
            salt.length !== 32 ||
            !nonce ||
            nonce.length !== 12 ||
            !tag ||
            tag.length !== 16 ||
            !ciphertext
        ) {
            throw new Error();
        }

        const { key, context } = keyMaterial(scope, salt);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(context);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        return credentialsSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
        // Never attach crypto errors or the encrypted payload as an error cause.
        throw new Error("Unable to decrypt Git credentials");
    }
}
