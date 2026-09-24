import type { Parser } from "nuqs-svelte";

export const listPageSize = 25;

export const pageParser = {
    parse(value: string) {
        if (!/^\d+$/.test(value)) return null;
        const page = Number(value);

        return page > 0 &&
            Number.isSafeInteger(page) &&
            Number.isSafeInteger((page - 1) * listPageSize)
            ? page
            : null;
    },
    serialize: String,
    defaultValue: 1,
} satisfies Parser<number> & { defaultValue: number };

export const deploymentIdParser = {
    parse(value: string) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
            ? value
            : null;
    },
    serialize: String,
} satisfies Parser<string>;
