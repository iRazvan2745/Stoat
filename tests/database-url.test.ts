import { describe, expect, it } from "vite-plus/test";

import {
    buildPostgresUrl,
    envValue,
    internalHostname,
    maskPostgresUrl,
    postgresConnectionParts,
    splitPostgresUrl,
    wrapUrlSegments,
} from "#lib/domain/resources/database-url";

describe("buildPostgresUrl", () => {
    it("encodes credentials and builds a postgresql URL", () => {
        expect(
            buildPostgresUrl(
                { database: "app", password: "p@ss word", user: "postgres" },
                { host: "db.internal", port: 5432 },
            ),
        ).toBe("postgresql://postgres:p%40ss%20word@db.internal:5432/app");
    });
});

describe("splitPostgresUrl", () => {
    it("does not add spaces around the password segment", () => {
        const display = splitPostgresUrl(
            "postgresql://postgres:fef70929-397e-4bd2-af4c-98483a06df22@db.internal:5432/app",
        );

        expect(display.beforePassword.endsWith(" ")).toBe(false);
        expect(display.password.startsWith(" ")).toBe(false);
        expect(display.password.endsWith(" ")).toBe(false);
        expect(display.afterPassword.startsWith(" ")).toBe(false);
        expect(`${display.beforePassword}${display.password}${display.afterPassword}`).toBe(
            display.url,
        );
    });
});

describe("maskPostgresUrl", () => {
    it("replaces the password with a single bullet until it is revealed", () => {
        const url = "postgresql://postgres:secret@db.internal:5432/app";

        expect(maskPostgresUrl(url, false)).toBe("postgresql://postgres:•@db.internal:5432/app");
        expect(maskPostgresUrl(url, true)).toBe(url);
    });
});

describe("wrapUrlSegments", () => {
    it("keeps the scheme together and splits at URL delimiters", () => {
        expect(wrapUrlSegments("postgresql://postgres:•@db.internal:5432/app")).toEqual([
            "postgresql://",
            "postgres",
            ":•",
            "@db.internal",
            ":5432",
            "/app",
        ]);
    });

    it("returns an empty list for an empty URL", () => {
        expect(wrapUrlSegments("")).toEqual([]);
    });
});

describe("postgresConnectionParts", () => {
    it("reads POSTGRES_* variables with postgres defaults", () => {
        expect(
            postgresConnectionParts([
                { name: "POSTGRES_USER", value: "app" },
                { name: "POSTGRES_PASSWORD", value: "s3cret" },
                { name: "POSTGRES_DB", value: "app" },
            ]),
        ).toEqual({
            database: "app",
            password: "s3cret",
            user: "app",
        });
        expect(postgresConnectionParts([])).toEqual({
            database: "postgres",
            password: "",
            user: "postgres",
        });
        expect(envValue([{ name: "FOO", value: "bar" }], "FOO", "fallback")).toBe("bar");
    });
});

describe("internalHostname", () => {
    it("uses the Uncloud .internal DNS name", () => {
        expect(internalHostname("postgres-abc12-postgres")).toBe(
            "postgres-abc12-postgres.internal",
        );
    });
});
