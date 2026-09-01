export const MAX_SERVICE_NAME_LENGTH = 128;

export function normalizeServiceName(name: string): string {
    const trimmed = name.trim();

    if (!trimmed) {
        throw new Error("Name is required");
    }

    if (trimmed.length > MAX_SERVICE_NAME_LENGTH) {
        throw new Error("Name is too long");
    }

    return trimmed;
}
