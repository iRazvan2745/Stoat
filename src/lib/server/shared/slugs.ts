// oxlint-disable require-unicode-regexp
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const toKebabCase = (name: string): string =>
    name
        .toLowerCase()
        .trim()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");

export const randomSlugSuffix = (): string =>
    Array.from(
        { length: 5 },
        () => SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)],
    ).join("");

const MAX_SLUG_ATTEMPTS = 5;

export const uniqueSlug = async (
    name: string,
    exists: (slug: string) => Promise<boolean>,
): Promise<string> => {
    const base = toKebabCase(name);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
        const slug = `${base}-${randomSlugSuffix()}`;

        // oxlint-disable-next-line no-await-in-loop
        if (!(await exists(slug))) {
            return slug;
        }
    }

    throw new Error(
        `Unable to generate a unique slug for "${name}" after ${MAX_SLUG_ATTEMPTS} attempts`,
    );
};
