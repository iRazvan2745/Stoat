import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import {
    clusters,
    gitConnections,
    organization,
    projects,
    resources,
} from "@stoat/db/schema/index";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { decryptGitCredentials, encryptGitCredentials } from "../../packages/api/src/git-secrets";

// DATABASE_URL is only used to create/drop a uniquely named disposable database.
describe("Git account migration 0017 (PostgreSQL)", () => {
    const databaseName = `stoat_git_migration_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let databaseCreated = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL)
            throw new Error("Testcontainers setup must provide DATABASE_URL");
        vi.stubEnv("BETTER_AUTH_SECRET", "git-migration-test-secret-at-least-32-bytes");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
    }, 30_000);

    afterAll(async () => {
        vi.unstubAllEnvs();
        await db?.$client.end();

        if (admin) {
            try {
                if (databaseCreated) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
            } finally {
                await admin.$client.end();
            }
        }
    });

    it("preserves legacy credentials and bound drafts while converting repository connections to generic accounts", async () => {
        const migrations = readMigrationFiles({
            migrationsFolder: resolve("packages/db/src/migrations"),
        });

        const accountMigration = migrations[17]!;
        expect(accountMigration.sql.join("\n")).toContain('ADD COLUMN "provider"');
        // Apply exactly through 0016 so the fixtures use the real legacy schema, not today's tables.
        await db.transaction(async (tx) => {
            for (const migration of migrations.slice(0, 17)) {
                for (const statement of migration.sql) await tx.execute(sql.raw(statement));
            }
        });

        const organizationId = randomUUID();
        const clusterId = randomUUID();
        const projectId = randomUUID();
        await db.insert(organization).values({
            id: organizationId,
            name: "Migration",
            slug: organizationId,
            createdAt: new Date(),
        });
        await db.insert(clusters).values({
            id: clusterId,
            name: "Migration",
            organizationId,
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "unused",
        });
        await db.insert(projects).values({ id: projectId, clusterId, name: "Migration" });

        const fixtures = [
            {
                name: "HTTPS token repository",
                url: "https://git.example.com:8443/team/apps/web.git",
                serverUrl: "https://git.example.com:8443",
                branch: "production",
                credentials: { username: "legacy-user", password: "legacy-token-never-return" },
            },
            {
                name: "SSH repository",
                url: "ssh://git@git.example.com:2222/team/nested/api.git",
                serverUrl: "ssh://git.example.com:2222",
                branch: "stable",
                credentials: {
                    privateKey: "legacy-private-key",
                    knownHosts: "[git.example.com]:2222 ssh-ed25519 legacy-host-key",
                },
            },
            {
                name: "Public repository",
                url: "https://public.example.com/team/public.git",
                serverUrl: "https://public.example.com",
                branch: "main",
                credentials: null,
            },
        ].map((fixture) => ({
            ...fixture,
            connectionId: randomUUID(),
            resourceId: randomUUID(),
        }));

        const spec = '# Keep comments and quotes\nservices:\n  web:\n    image: "nginx:alpine"\n';

        const settings = { env: 'KEEP=value\nQUOTED="unchanged"', prefixNames: false };

        const source = {
            branch: "release/deploy",
            path: "deploy/compose.yaml",
            revision: "a".repeat(40),
        };

        for (const fixture of fixtures) {
            const encrypted = fixture.credentials
                ? encryptGitCredentials(fixture.credentials, {
                      organizationId,
                      connectionId: fixture.connectionId,
                  })
                : null;

            await db.$client.query(
                `INSERT INTO git_connections (id, organization_id, name, url, branch, encrypted_credentials, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, '2025-01-02T03:04:05Z', '2025-06-07T08:09:10Z')`,
                [
                    fixture.connectionId,
                    organizationId,
                    fixture.name,
                    fixture.url,
                    fixture.branch,
                    encrypted,
                ],
            );
            await db.$client.query(
                `INSERT INTO resources (id, project_id, name, type, spec, settings, git_connection_id, git_source, created_at, updated_at)
                 VALUES ($1, $2, $3, 'compose', $4, $5, $6, $7, '2025-02-03T04:05:06Z', '2025-07-08T09:10:11Z')`,
                [
                    fixture.resourceId,
                    projectId,
                    fixture.name,
                    spec,
                    settings,
                    fixture.connectionId,
                    source,
                ],
            );
        }

        const detachedId = randomUUID();
        await db.$client.query(
            `INSERT INTO resources (id, project_id, name, type, spec, settings, created_at, updated_at)
             VALUES ($1, $2, 'Local draft', 'compose', $3, $4, now(), now())`,
            [detachedId, projectId, spec, settings],
        );

        const connectionsBefore = (
            await db.$client.query("SELECT * FROM git_connections ORDER BY id")
        ).rows;

        const resourcesBefore = (await db.$client.query("SELECT * FROM resources ORDER BY id"))
            .rows;

        await db.transaction(async (tx) => {
            for (const statement of accountMigration.sql) await tx.execute(sql.raw(statement));
        });

        const connectionsAfter = (
            await db.$client.query("SELECT * FROM git_connections ORDER BY id")
        ).rows;

        expect(connectionsAfter).toEqual(
            connectionsBefore.map(({ url, branch, ...connection }) => ({
                ...connection,
                provider: "generic",
                server_url: fixtures.find((fixture) => fixture.connectionId === connection.id)!
                    .serverUrl,
                auth_type: "token",
                account: null,
                repositories: [{ url, name: connection.name, defaultBranch: branch }],
            })),
        );
        expect((await db.$client.query("SELECT * FROM resources ORDER BY id")).rows).toEqual(
            resourcesBefore.map((resource) => ({
                ...resource,
                git_source: resource.git_source
                    ? {
                          ...resource.git_source,
                          repositoryUrl: fixtures.find(
                              (fixture) => fixture.connectionId === resource.git_connection_id,
                          )!.url,
                      }
                    : null,
            })),
        );

        // The current Drizzle schema can read every migrated row, and scoped ciphertext still decrypts.
        const migrated = await db.select().from(gitConnections);
        expect(migrated).toHaveLength(fixtures.length);

        for (const fixture of fixtures) {
            const connection = migrated.find(
                (connection) => connection.id === fixture.connectionId,
            )!;

            if (fixture.credentials) {
                expect(
                    decryptGitCredentials(connection.encryptedCredentials!, {
                        organizationId,
                        connectionId: fixture.connectionId,
                    }),
                ).toEqual(fixture.credentials);
            } else expect(connection.encryptedCredentials).toBeNull();
        }

        expect(await db.select({ id: resources.id }).from(resources)).toHaveLength(
            fixtures.length + 1,
        );
    }, 30_000);
});
