import { describe, expect, it } from "vite-plus/test";

import { toKebabCase, uniqueSlug } from "#lib/server/shared/slugs";

describe("toKebabCase", () => {
    it("lowercases and collapses non-alphanumerics", () => {
        expect(toKebabCase("  My Cool App! ")).toBe("my-cool-app");
    });
});

describe("uniqueSlug", () => {
    it("returns the first candidate that does not exist", async () => {
        const checked: string[] = [];
        const slug = await uniqueSlug("My App", (candidate) => {
            checked.push(candidate);
            return Promise.resolve(false);
        });

        expect(slug).toMatch(/^my-app-[a-z0-9]{5}$/u);
        expect(checked).toEqual([slug]);
    });

    it("retries until an unused slug is found", async () => {
        let calls = 0;
        const slug = await uniqueSlug("My App", () => {
            calls += 1;
            return Promise.resolve(calls < 3);
        });

        expect(slug).toMatch(/^my-app-[a-z0-9]{5}$/u);
        expect(calls).toBe(3);
    });

    it("throws instead of returning a known-duplicate slug", async () => {
        await expect(uniqueSlug("My App", () => Promise.resolve(true))).rejects.toThrow(
            'Unable to generate a unique slug for "My App" after 5 attempts',
        );
    });
});
