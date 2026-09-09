const PNG_MAGIC = "iVBORw0KGgo";
const JPEG_MAGIC = "/9j/";
const GIF_MAGIC = "R0lGOD";
const WEBP_MAGIC = "UklGR";
const SVG_MAGIC = "PHN2Zy";
const XML_MAGIC = "PD94bW";
const BASE64_BODY = /^[A-Za-z0-9+/]+=*$/u;
const POSTGRES_FALLBACK_ICON = "/templates/postgresql/logo";
const BASE64_CHUNK_SIZE = 0x80_00;

export const MAX_RESOURCE_ICON_LENGTH = 400_000;
export const MAX_RESOURCE_ICON_FILE_BYTES = 256 * 1024;
export const RESOURCE_ICON_ACCEPT =
    "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg";
export const ALLOWED_RESOURCE_ICON_TYPES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
]);

const inferBase64ImageType = (value: string): string => {
    if (value.startsWith(PNG_MAGIC)) {
        return "image/png";
    }

    if (value.startsWith(JPEG_MAGIC)) {
        return "image/jpeg";
    }

    if (value.startsWith(GIF_MAGIC)) {
        return "image/gif";
    }

    if (value.startsWith(WEBP_MAGIC)) {
        return "image/webp";
    }

    if (value.startsWith(SVG_MAGIC) || value.startsWith(XML_MAGIC)) {
        return "image/svg+xml";
    }

    return "image/png";
};

const isSafeHttpUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
};

const isSafeRelativeUrl = (value: string): boolean =>
    value.startsWith("/") && !value.startsWith("//");

export function resourceIconSrc(icon: string | null | undefined): string | null {
    const trimmed = icon?.trim();

    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith("data:image/")) {
        return trimmed;
    }

    if (isSafeRelativeUrl(trimmed) || isSafeHttpUrl(trimmed)) {
        return trimmed;
    }

    const compact = trimmed.replaceAll(/\s/gu, "");

    if (!BASE64_BODY.test(compact)) {
        return null;
    }

    return `data:${inferBase64ImageType(compact)};base64,${compact}`;
}

export function resolveResourceIcon(
    icon: string | null | undefined,
    type?: string | null,
): string | null {
    return resourceIconSrc(icon) ?? (type === "postgresql" ? POSTGRES_FALLBACK_ICON : null);
}

export function normalizeResourceIcon(icon: string | null | undefined): string | null {
    const trimmed = icon?.trim() ?? "";

    if (!trimmed) {
        return null;
    }

    if (trimmed.length > MAX_RESOURCE_ICON_LENGTH) {
        throw new Error("Resource icon is too large");
    }

    if (!resourceIconSrc(trimmed)) {
        throw new Error("Invalid resource icon");
    }

    return trimmed;
}

const iconTypeFromFileName = (name: string): string | undefined => {
    const lower = name.toLowerCase();

    if (lower.endsWith(".png")) {
        return "image/png";
    }

    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
        return "image/jpeg";
    }

    if (lower.endsWith(".gif")) {
        return "image/gif";
    }

    if (lower.endsWith(".webp")) {
        return "image/webp";
    }

    if (lower.endsWith(".svg")) {
        return "image/svg+xml";
    }

    return undefined;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
        binary += String.fromCodePoint(...bytes.subarray(index, index + BASE64_CHUNK_SIZE));
    }

    return btoa(binary);
};

export async function resourceIconFromFile(file: File): Promise<string> {
    if (file.size > MAX_RESOURCE_ICON_FILE_BYTES) {
        throw new Error("Icon must be 256 KB or smaller");
    }

    const type = ALLOWED_RESOURCE_ICON_TYPES.has(file.type)
        ? file.type
        : iconTypeFromFileName(file.name);

    if (!type) {
        throw new Error("Use a PNG, JPEG, GIF, WebP, or SVG image");
    }

    const dataUri = `data:${type};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;

    return normalizeResourceIcon(dataUri) ?? dataUri;
}
