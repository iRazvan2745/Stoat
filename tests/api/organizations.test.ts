import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@stoat/db";
import { createAuth } from "../../packages/auth/src";
import { call } from "@orpc/server";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { listUserOrganizations } from "@stoat/db/organizations";

describe("organization authentication (PostgreSQL)", () => {
    const databaseName = `stoat_auth_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let auth: ReturnType<typeof createAuth>;
    const baseURL = "http://localhost:5173";
    const password = "test-password-long-enough";
    let first: { userId: string; organizationId: string; cookie: string };
    let second: typeof first;

    const existingStateQuery = `SELECT
        (SELECT jsonb_agg(o ORDER BY id) FROM organization o
            WHERE id IN ('existing-old', 'existing-chosen')) AS organizations,
        (SELECT jsonb_agg(m ORDER BY id) FROM member m
            WHERE user_id = 'existing') AS memberships`;

    let existingState: unknown;

    async function request(path: string, body?: Record<string, string>, cookie?: string) {
        const headers = new Headers({ origin: baseURL });

        if (body) headers.set("content-type", "application/json");

        if (cookie) headers.set("cookie", cookie);

        return auth.handler(
            new Request(`${baseURL}/api/auth${path}`, {
                method: body ? "POST" : "GET",
                headers,
                body: body ? JSON.stringify(body) : undefined,
            }),
        );
    }

    async function signup(email: string) {
        const response = await request("/sign-up/email", {
            name: "Same Name",
            email,
            password,
        });

        expect(response.status).toBe(200);
        const body = await response.json();

        const cookie = response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");

        const organizations = await listUserOrganizations(db, body.user.id);
        expect(organizations).toHaveLength(1);
        expect(organizations[0].role).toBe("owner");
        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        expect(session?.session.activeOrganizationId).toBe(organizations[0].id);

        return { userId: body.user.id, organizationId: organizations[0].id, cookie };
    }

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        const folder = resolve("packages/db/src/migrations");
        const historical = mkdtempSync(join(tmpdir(), "stoat-migrations-"));

        try {
            const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8"));

            const cutoff = journal.entries.findIndex(
                (entry: { tag: string }) => entry.tag === "0007_default_organizations",
            );

            expect(cutoff).toBeGreaterThan(0);
            expect(journal.entries[cutoff - 1].tag).toBe("0006_fair_iron_patriot");
            journal.entries = journal.entries.slice(0, cutoff);
            mkdirSync(join(historical, "meta"));
            writeFileSync(join(historical, "meta/_journal.json"), JSON.stringify(journal));

            for (const entry of journal.entries)
                copyFileSync(
                    join(folder, `${entry.tag}.sql`),
                    join(historical, `${entry.tag}.sql`),
                );
            await migrate(db, { migrationsFolder: historical });
            await db.$client.query(
                `INSERT INTO "user" (id, name, email) VALUES
                    ('legacy', 'Same Name', 'legacy@example.test'),
                    ('legacy-same', 'Same Name', 'legacy-same@example.test'),
                    ('legacy-empty', '', 'legacy-empty@example.test'),
                    ('legacy-blank', '   ', 'legacy-blank@example.test'),
                    ('existing', 'Existing', 'existing@example.test')`,
            );
            // These rows must predate the provisioning trigger, not exercise it.
            expect((await db.$client.query("SELECT * FROM organization")).rows).toEqual([]);
            expect((await db.$client.query("SELECT * FROM member")).rows).toEqual([]);
            await db.$client.query(`
                INSERT INTO organization (id, name, slug, logo, metadata, created_at) VALUES
                    ('existing-old', 'Original workspace', 'original-workspace',
                        'https://example.test/logo.png', '{"preserved":true}', '2020-01-01'),
                    ('existing-chosen', 'Chosen workspace', 'chosen-workspace',
                        NULL, NULL, '2021-01-01');
                INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
                    ('existing-a', 'existing-chosen', 'existing', 'admin', '2021-01-01'),
                    ('existing-z', 'existing-old', 'existing', 'member', '2020-01-01');
                INSERT INTO session (id, token, user_id, expires_at, updated_at, active_organization_id)
                    SELECT id || '-null', id || '-token', id, now() + interval '1 day', now(), NULL
                    FROM "user";
                INSERT INTO session (id, token, user_id, expires_at, updated_at, active_organization_id)
                    VALUES ('existing-choice', 'existing-choice-token', 'existing',
                        now() + interval '1 day', now(), 'existing-chosen');
            `);
            existingState = (await db.$client.query(existingStateQuery)).rows;
            expect(
                (
                    await db.$client.query(
                        "SELECT id FROM session WHERE active_organization_id IS NULL ORDER BY id",
                    )
                ).rows,
            ).toEqual([
                { id: "existing-null" },
                { id: "legacy-blank-null" },
                { id: "legacy-empty-null" },
                { id: "legacy-null" },
                { id: "legacy-same-null" },
            ]);
            await migrate(db, { migrationsFolder: folder });
        } finally {
            rmSync(historical, { recursive: true, force: true });
        }

        auth = createAuth(
            {
                BETTER_AUTH_URL: baseURL,
                BETTER_AUTH_SECRET: "integration-test-secret-at-least-32-characters",
            },
            db,
        );
    }, 30000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("backfills distinct owned organizations for same-name users without memberships", async () => {
        const legacy = await listUserOrganizations(db, "legacy");
        const sameName = await listUserOrganizations(db, "legacy-same");

        expect(legacy).toHaveLength(1);
        expect(sameName).toHaveLength(1);
        expect(legacy[0]).toMatchObject({ name: "Same Name's organization", role: "owner" });
        expect(sameName[0]).toMatchObject({ name: "Same Name's organization", role: "owner" });
        expect(legacy[0].id).not.toBe(sameName[0].id);
        expect(legacy[0].slug).not.toBe(sameName[0].slug);
    });

    it.each(["legacy-empty", "legacy-blank"])(
        "uses the personal organization fallback for %s",
        async (userId) => {
            const organizations = await listUserOrganizations(db, userId);

            expect(organizations).toHaveLength(1);
            expect(organizations[0]).toMatchObject({
                name: "Personal's organization",
                role: "owner",
            });
        },
    );

    it("preserves existing organizations and memberships without provisioning another", async () => {
        expect((await db.$client.query(existingStateQuery)).rows).toEqual(existingState);
        expect(await listUserOrganizations(db, "existing")).toHaveLength(2);
        expect((await db.$client.query("SELECT id FROM organization")).rows).toHaveLength(6);
        expect((await db.$client.query("SELECT id FROM member")).rows).toHaveLength(6);
    });

    it("backfills null session organizations with the user's earliest membership", async () => {
        for (const userId of [
            "legacy",
            "legacy-same",
            "legacy-empty",
            "legacy-blank",
            "existing",
        ]) {
            const [organization] = await listUserOrganizations(db, userId);

            const result = await db.$client.query(
                "SELECT active_organization_id FROM session WHERE id = $1",
                [`${userId}-null`],
            );

            expect(result.rows).toEqual([{ active_organization_id: organization.id }]);
        }

        expect((await listUserOrganizations(db, "existing"))[0].id).toBe("existing-old");
    });

    it("preserves a nonnull session organization instead of replacing it with the earliest", async () => {
        const result = await db.$client.query(
            "SELECT active_organization_id FROM session WHERE id = 'existing-choice'",
        );

        expect(result.rows).toEqual([{ active_organization_id: "existing-chosen" }]);
    });

    it("keeps organizations, memberships, sessions and the migration journal stable on runner replay", async () => {
        const query = `SELECT
            (SELECT jsonb_agg(o ORDER BY id) FROM organization o) AS organizations,
            (SELECT jsonb_agg(m ORDER BY id) FROM member m) AS memberships,
            (SELECT jsonb_agg(s ORDER BY id) FROM session s) AS sessions,
            (SELECT jsonb_agg(m ORDER BY id) FROM drizzle.__drizzle_migrations m) AS migrations`;

        const before = (await db.$client.query(query)).rows;

        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        expect((await db.$client.query(query)).rows).toEqual(before);
    });

    it("creates distinct owned organizations and active sessions for same-name users", async () => {
        first = await signup("first@example.test");
        second = await signup("second@example.test");
        expect(first.organizationId).not.toBe(second.organizationId);
    });

    it("rejects duplicate signup without creating another organization", async () => {
        await request("/sign-up/email", {
            name: "Same Name",
            email: "first@example.test",
            password,
        });
        expect(await listUserOrganizations(db, first.userId)).toHaveLength(1);
    });

    it("logs in with an active organization and rejects incorrect credentials", async () => {
        const bad = await request("/sign-in/email", {
            email: "first@example.test",
            password: "incorrect-password",
        });

        expect(bad.status).toBe(401);
        const good = await request("/sign-in/email", { email: "first@example.test", password });
        expect(good.status).toBe(200);
        expect(await listUserOrganizations(db, first.userId)).toHaveLength(1);

        const cookie = good.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");

        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        expect(session?.session.activeOrganizationId).toBe(first.organizationId);
    });

    it("denies switching to another user's organization", async () => {
        const response = await request(
            "/organization/set-active",
            { organizationId: second.organizationId },
            first.cookie,
        );

        expect(response.ok).toBe(false);

        const restored = await request(
            "/organization/set-active",
            { organizationId: first.organizationId },
            first.cookie,
        );

        expect(restored.ok).toBe(true);
    });

    it("scopes cluster access and rejects forged organization and unauthenticated access", async () => {
        for (const user of [first, second]) {
            await db.$client.query(
                `INSERT INTO clusters (id, name, organization_id, created_at, updated_at, sidecar_url, sidecar_token) VALUES ($1, $2, $3, now(), now(), 'http://sidecar.invalid', 'secret')`,
                [randomUUID(), user.userId, user.organizationId],
            );
        }

        const session = await auth.api.getSession({
            headers: new Headers({ cookie: first.cookie }),
        });

        const result = await call(clusterRouter.listClusters, undefined, {
            context: { db, session },
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].organizationId).toBe(first.organizationId);
        expect(result.items[0]).not.toHaveProperty("sidecarToken");
        expect(result.total).toBe(1);
        await expect(
            call(clusterRouter.listClusters, undefined, {
                context: { db, session: null },
            }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        await expect(
            call(clusterRouter.listClusters, undefined, {
                context: {
                    db,
                    session: {
                        ...session!,
                        session: {
                            ...session!.session,
                            activeOrganizationId: second.organizationId,
                        },
                    },
                },
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("creates additional organizations, switches to them, and invalidates logout sessions", async () => {
        const response = await request(
            "/organization/create",
            { name: "Another workspace", slug: "another-workspace" },
            first.cookie,
        );

        expect(response.status).toBe(200);
        const organization = await response.json();

        const session = await auth.api.getSession({
            headers: new Headers({ cookie: first.cookie }),
        });

        expect(session?.session.activeOrganizationId).toBe(organization.id);

        const switched = await request(
            "/organization/set-active",
            { organizationId: first.organizationId },
            first.cookie,
        );

        expect(switched.ok).toBe(true);
        const logout = await request("/sign-out", {}, first.cookie);
        expect(logout.ok).toBe(true);
        expect(
            await auth.api.getSession({ headers: new Headers({ cookie: first.cookie }) }),
        ).toBeNull();
    });

    it("rejects a real authenticated session after its organization membership is revoked", async () => {
        const user = await signup("revoked@example.test");
        const headers = new Headers({ cookie: user.cookie });
        const session = await auth.api.getSession({ headers });

        expect(session?.session.activeOrganizationId).toBe(user.organizationId);
        await expect(
            call(clusterRouter.listClusters, undefined, { context: { db, session } }),
        ).resolves.toMatchObject({ items: [], total: 0 });

        const deleted = await db.$client.query(
            "DELETE FROM member WHERE user_id = $1 AND organization_id = $2",
            [user.userId, user.organizationId],
        );

        expect(deleted.rowCount).toBe(1);
        const staleSession = await auth.api.getSession({ headers });

        expect(staleSession?.user.id).toBe(user.userId);
        expect(staleSession?.session.activeOrganizationId).toBe(user.organizationId);
        await expect(
            call(clusterRouter.listClusters, undefined, {
                context: { db, session: staleSession },
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rolls back the user when organization provisioning fails", async () => {
        const client = await db.$client.connect();
        await client.query("BEGIN");

        try {
            await client.query(
                "ALTER TABLE organization ADD CONSTRAINT reject_test_org CHECK (name <> 'Reject''s organization')",
            );
            await expect(
                client.query(
                    `INSERT INTO "user" (id, name, email) VALUES ('reject', 'Reject', 'reject@example.test')`,
                ),
            ).rejects.toBeDefined();
        } finally {
            await client.query("ROLLBACK");
            client.release();
        }

        const result = await db.$client.query(`SELECT id FROM "user" WHERE id = 'reject'`);
        expect(result.rows).toHaveLength(0);
    });
});
