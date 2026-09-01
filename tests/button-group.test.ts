import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = readFileSync(
    new URL("../node_modules/m3-svelte/package/buttons/ButtonGroup.svelte", import.meta.url),
    "utf-8",
);

describe("ButtonGroup spec tokens", () => {
    it("uses 18/12/8 dp standard gaps and 2 dp connected gaps", () => {
        expect(source).toContain(".standard.size-xs {\n    gap: 1.125rem;");
        expect(source).toContain(".standard.size-s {\n    gap: 0.75rem;");
        expect(source).toContain(".standard:is(.size-m, .size-l, .size-xl) {\n    gap: 0.5rem;");
        expect(source).toContain(".connected {\n    gap: 0.125rem;");
    });

    it("uses XS 4 / S 8 / M 8 / L 16 / XL 20 inner corners", () => {
        expect(source).toMatch(
            /\.size-xs \{[\s\S]*?--inner-corner: var\(--m3-shape-extra-small\);/u,
        );
        expect(source).toMatch(/\.size-s \{[\s\S]*?--inner-corner: var\(--m3-shape-small\);/u);
        expect(source).toMatch(/\.size-m \{[\s\S]*?--inner-corner: var\(--m3-shape-small\);/u);
        expect(source).toMatch(/\.size-l \{[\s\S]*?--inner-corner: var\(--m3-shape-large\);/u);
        expect(source).toMatch(
            /\.size-xl \{[\s\S]*?--inner-corner: var\(--m3-shape-large-increased\);/u,
        );
    });

    it("rounds only the outer ends of a connected round group", () => {
        expect(source).toContain(".connected.round > :global(.m3-container:first-child)");
        expect(source).toContain(".connected.round > :global(.m3-container:last-child)");
        expect(source).not.toContain("border-radius: calc(var(--button-group-min) / 2)");
        expect(source).not.toContain("border-start-start-radius: var(--m3-shape-medium)");
    });

    it("keeps width morph on standard groups only", () => {
        expect(source).toContain(
            ".standard\n    > :global(\n      .m3-container:not(.icon-full):is(",
        );
        expect(source).toContain("--button-group-selected-scale");
        expect(source).not.toMatch(
            /\.button-group\.button-group\s*>\s*:global\(\s*\.m3-container\.m3-container:not\(\.icon-full\):is\(/u,
        );
    });

    it("enforces a 48 dp min width on connected XS and S", () => {
        expect(source).toContain(
            ".connected:is(.size-xs, .size-s) > :global(.m3-container) {\n    min-width: 3rem;",
        );
    });
});
