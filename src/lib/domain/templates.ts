import type { EnvironmentVariable } from "#lib/domain/environment";

export interface TemplateManifest {
    description: string;
    icon?: string;
    name: string;
    tags: string[];
    type: string;
}

export interface TemplateVersionSummary {
    version: string;
}

export interface ServiceTemplate {
    appId: string;
    description: string;
    logoSrc: string | null;
    name: string;
    tags: string[];
    type: string;
    versions: TemplateVersionSummary[];
}

export interface TemplateVersion {
    compose: string;
    manifest: TemplateManifest;
    variables: EnvironmentVariable[];
    version: string;
}

export function svglIconUrl(icon: string): string {
    const slug = icon.replace(/\.svg$/iu, "");
    return `https://api.svgl.app/svg/${encodeURIComponent(slug)}.svg`;
}

export function ensureSvgNamespace(svg: string): string {
    if (/<svg\b[^>]*\bxmlns\s*=/iu.test(svg)) {
        return svg;
    }

    return svg.replace(/<svg\b/iu, '<svg xmlns="http://www.w3.org/2000/svg"');
}

const MIN_SECRET_LENGTH = 1;
const MAX_SECRET_LENGTH = 256;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const randomBase64 = (length: number): string => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);

    let result = "";

    for (const byte of bytes) {
        result += BASE64_ALPHABET[byte % BASE64_ALPHABET.length];
    }

    return result;
};

export function expandTemplateSecrets(source: string): string {
    return source.replaceAll(
        /\{\{\s*(?<token>UUID|\d+)\s*\}\}/giu,
        (placeholder, token: string) => {
            if (token.toUpperCase() === "UUID") {
                return crypto.randomUUID();
            }

            const length = Math.trunc(Number(token));

            if (
                !Number.isInteger(length) ||
                length < MIN_SECRET_LENGTH ||
                length > MAX_SECRET_LENGTH
            ) {
                throw new Error(
                    `Invalid secret placeholder ${placeholder}: length must be between ${MIN_SECRET_LENGTH} and ${MAX_SECRET_LENGTH}`,
                );
            }

            return randomBase64(length);
        },
    );
}

export function expandTemplateVariables(
    variables: readonly EnvironmentVariable[],
): EnvironmentVariable[] {
    return variables.map((variable) => ({
        name: variable.name,
        value: expandTemplateSecrets(variable.value),
    }));
}
