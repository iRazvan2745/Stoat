import { describe, expect, it } from "vite-plus/test";

import { parseAnsiLogLines, stripAnsi } from "#lib/domain/logs/ansi";

const ESC = "\u001B";

describe("parseAnsiLogLines", () => {
    it("renders SGR colors and styles as structured segments", () => {
        const lines = parseAnsiLogLines(`${ESC}[2mmuted ${ESC}[32mgreen${ESC}[0m plain`);

        expect(lines).toEqual([
            [
                {
                    style: {
                        bold: false,
                        dim: true,
                        inverse: false,
                        italic: false,
                        strikethrough: false,
                        underline: false,
                    },
                    text: "muted ",
                },
                {
                    style: {
                        bold: false,
                        dim: true,
                        foreground: { kind: "named", name: "green" },
                        inverse: false,
                        italic: false,
                        strikethrough: false,
                        underline: false,
                    },
                    text: "green",
                },
                {
                    style: {
                        bold: false,
                        dim: false,
                        inverse: false,
                        italic: false,
                        strikethrough: false,
                        underline: false,
                    },
                    text: " plain",
                },
            ],
        ]);
    });

    it("keeps ANSI styles across lines and removes terminal controls", () => {
        const lines = parseAnsiLogLines(`${ESC}[31mfirst\nsecond${ESC}[0m\r`);

        expect(lines).toHaveLength(2);
        expect(lines[0]?.[0]?.text).toBe("first");
        expect(lines[1]?.[0]).toMatchObject({
            style: { foreground: { kind: "named", name: "red" } },
            text: "second",
        });
        expect(stripAnsi(`${ESC}[31mfirst\nsecond${ESC}[0m\r`)).toBe("first\nsecond");
    });

    it("supports 256-color and true-color SGR values", () => {
        const [line] = parseAnsiLogLines(`${ESC}[38;5;123mindexed${ESC}[48;2;1;2;3mrgb${ESC}[0m`);

        expect(line).toEqual([
            {
                style: {
                    bold: false,
                    dim: false,
                    foreground: { index: 123, kind: "indexed" },
                    inverse: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                },
                text: "indexed",
            },
            {
                style: {
                    background: { blue: 3, green: 2, kind: "rgb", red: 1 },
                    bold: false,
                    dim: false,
                    foreground: { index: 123, kind: "indexed" },
                    inverse: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                },
                text: "rgb",
            },
        ]);
    });
});
