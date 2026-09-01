import { describe, expect, it } from "vite-plus/test";

import {
    parseEnvFile,
    serializeEnvFile,
    validateEnvironmentVariables,
} from "#lib/domain/environment";

describe("parseEnvFile", () => {
    it("parses names, quoted values, comments, and export lines", () => {
        const parsed = parseEnvFile(`
# comment
DATABASE_URL=postgres://local
export TOKEN="abc def"
EMPTY=
QUOTED='keep # hash'
PLAIN=bar # inline
`);

        expect(parsed.errors).toEqual([]);
        expect(parsed.variables).toEqual([
            { name: "DATABASE_URL", value: "postgres://local" },
            { name: "TOKEN", value: "abc def" },
            { name: "EMPTY", value: "" },
            { name: "QUOTED", value: "keep # hash" },
            { name: "PLAIN", value: "bar" },
        ]);
    });

    it("reports missing equals, invalid names, and duplicates", () => {
        const parsed = parseEnvFile(`FOO
1BAD=no
FOO=one
FOO=two
`);

        expect(parsed.variables).toEqual([{ name: "FOO", value: "one" }]);
        expect(parsed.errors).toEqual([
            'Line 1: missing "="',
            'Line 2: invalid name "1BAD"',
            'Line 4: duplicate name "FOO"',
        ]);
    });
});

describe("serializeEnvFile", () => {
    it("round-trips values that need quoting", () => {
        const source = serializeEnvFile([
            { name: "PLAIN", value: "ok" },
            { name: "SPACED", value: "hello world" },
            { name: "HASH", value: "keep # hash" },
        ]);

        expect(source).toBe('PLAIN=ok\nSPACED="hello world"\nHASH="keep # hash"');
        expect(parseEnvFile(source)).toEqual({
            errors: [],
            variables: [
                { name: "PLAIN", value: "ok" },
                { name: "SPACED", value: "hello world" },
                { name: "HASH", value: "keep # hash" },
            ],
        });
    });
});

describe("validateEnvironmentVariables", () => {
    it("rejects invalid and duplicate names", () => {
        expect(
            validateEnvironmentVariables([
                { name: "FOO", value: "1" },
                { name: "FOO", value: "2" },
                { name: "1NO", value: "3" },
                { name: "  ", value: "skip" },
            ]),
        ).toEqual(['Duplicate name "FOO"', 'Invalid name "1NO"']);
    });
});
