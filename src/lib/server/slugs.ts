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

export const uniqueSlug = async (
  name: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> => {
  let slug = `${toKebabCase(name)}-${randomSlugSuffix()}`;

  for (
    let attempt = 0;
    // oxlint-disable-next-line no-await-in-loop
    attempt < 5 && (await exists(slug));
    attempt += 1
  ) {
    slug = `${toKebabCase(name)}-${randomSlugSuffix()}`;
  }

  return slug;
};
