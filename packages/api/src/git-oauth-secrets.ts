import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";

type Scope = {
    organizationId: string;
    id: string;
    provider: string;
    serverUrl: string;
    clientId: string;
};

const domain = "stoat/git-oauth-client-secret/v1";

function keyMaterial(scope: Scope, salt: Buffer) {
    const secret = process.env.BETTER_AUTH_SECRET;

    if (!secret || Buffer.byteLength(secret) < 32) throw new Error();

    const values = [
        scope.organizationId,
        scope.id,
        scope.provider,
        scope.serverUrl,
        scope.clientId,
    ];

    if (!z.array(z.string().min(1).max(2048)).safeParse(values).success) throw new Error();
    // Bind the secret to the organization, app, and destination, not just its row ID.
    const context = Buffer.from(JSON.stringify([domain, ...values]));

    return { context, key: hkdfSync("sha256", secret, salt, context, 32) };
}

export function encryptGitOAuthClientSecret(secret: string, scope: Scope): string {
    try {
        if (!z.string().min(1).max(8192).safeParse(secret).success) throw new Error();
        const salt = randomBytes(32);
        const nonce = randomBytes(12);
        const { key, context } = keyMaterial(scope, salt);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(context);
        const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

        return `v1.${[salt, nonce, cipher.getAuthTag(), ciphertext]
            .map((part) => part.toString("base64url"))
            .join(".")}`;
    } catch {
        throw new Error("Unable to encrypt Git OAuth client secret");
    }
}

export function decryptGitOAuthClientSecret(envelope: string, scope: Scope): string {
    try {
        if (
            !z
                .string()
                .max(64 * 1024)
                .safeParse(envelope).success
        )
            throw new Error();
        const parts = envelope.split(".");

        if (parts.length !== 5 || parts[0] !== "v1") throw new Error();

        const [salt, nonce, tag, ciphertext] = parts.slice(1).map((part) => {
            const bytes = Buffer.from(part, "base64url");

            if (!part || bytes.toString("base64url") !== part) throw new Error();

            return bytes;
        });

        if (salt?.length !== 32 || nonce?.length !== 12 || tag?.length !== 16 || !ciphertext)
            throw new Error();
        const { key, context } = keyMaterial(scope, salt);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(context);
        decipher.setAuthTag(tag);

        const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
            "utf8",
        );

        if (!secret || secret.length > 8192) throw new Error();

        return secret;
    } catch {
        throw new Error("Unable to decrypt Git OAuth client secret");
    }
}
