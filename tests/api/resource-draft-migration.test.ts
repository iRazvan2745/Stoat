import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { clusters, organization, projects, resources } from "@stoat/db/schema/index";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// DATABASE_URL is only used to create/drop a uniquely named disposable database.
describe("Resource draft migration 0020 (PostgreSQL)", () => {
    const databaseName = `stoat_draft_migration_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let databaseCreated = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL)
            throw new Error("Testcontainers setup must provide DATABASE_URL");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            try {
                if (databaseCreated) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
            } finally {
                await admin.$client.end();
            }
        }
    });

    it("copies drafts while restoring only confirmed deployed specs and preserving legacy monitoring", async () => {
        const migrations = readMigrationFiles({
            migrationsFolder: resolve("packages/db/src/migrations"),
        });

        const draftMigration = migrations[20]!;
        expect(draftMigration.sql.join("\n")).toContain('ADD COLUMN "draft_spec"');
        // Apply exactly through 0019; today's resources schema already includes draft_spec.
        await db.transaction(async (tx) => {
            for (const migration of migrations.slice(0, 20)) {
                for (const statement of migration.sql) await tx.execute(sql.raw(statement));
            }
        });

        const organizationId = randomUUID();
        const clusterId = randomUUID();
        const projectId = randomUUID();
        const initializedClusterId = randomUUID();
        const initializedProjectId = randomUUID();
        await db.insert(organization).values({
            id: organizationId,
            name: "Migration",
            slug: organizationId,
            createdAt: new Date(),
        });
        await db.insert(clusters).values([
            {
                id: clusterId,
                name: "Uninitialized",
                organizationId,
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "unused",
            },
            {
                id: initializedClusterId,
                name: "Initialized",
                organizationId,
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "unused",
                initializedAt: new Date("2025-01-01T00:00:00Z"),
                initializationStatus: "ready",
            },
        ]);
        await db.insert(projects).values([
            { id: projectId, clusterId, name: "Migration" },
            { id: initializedProjectId, clusterId: initializedClusterId, name: "Monitoring" },
        ]);

        const deployedId = randomUUID();
        const failedId = randomUUID();
        const uninitializedMonitoringId = randomUUID();
        const initializedMonitoringId = randomUUID();
        const draftSpec = '# Saved draft edits\nservices:\n  web:\n    image: "nginx:draft"\n';
        const readySpec = 'services:\n  web:\n    image: "nginx:ready"\n';
        const legacySpec = "services:\n  web:\n    image: nginx:legacy\n";
        const template = "services:\n  metrics:\n    image: greptime/greptimedb:latest\n";

        const fixtures = [
            {
                id: deployedId,
                name: "Latest confirmed deployment",
                spec: draftSpec,
                expectedSpec: readySpec,
            },
            { id: failedId, name: "Failed only", spec: draftSpec, expectedSpec: null },
            { id: randomUUID(), name: "No history", spec: legacySpec, expectedSpec: legacySpec },
            { id: randomUUID(), name: "Empty legacy resource", spec: null, expectedSpec: null },
            {
                id: uninitializedMonitoringId,
                name: "Uninitialized monitoring",
                spec: template,
                expectedSpec: null,
            },
            {
                id: initializedMonitoringId,
                projectId: initializedProjectId,
                name: "Initialized monitoring",
                spec: template,
                expectedSpec: template,
            },
        ].map((fixture) => ({ projectId, ...fixture }));

        for (const fixture of fixtures) {
            await db.$client.query(
                `INSERT INTO resources (id, project_id, name, type, spec, created_at, updated_at)
                 VALUES ($1, $2, $3, 'compose', $4, '2025-01-01T00:00:00Z', '2025-01-10T00:00:00Z')`,
                [fixture.id, fixture.projectId, fixture.name, fixture.spec],
            );
        }

        // Finish time wins over creation time; equal finish times use the newest creation.
        const history = [
            {
                resourceId: deployedId,
                status: "ready",
                spec: "services: {web: {image: nginx:older-tie}}",
                createdAt: "2025-01-01T00:00:00Z",
                finishedAt: "2025-01-05T00:00:00Z",
            },
            {
                resourceId: deployedId,
                status: "ready",
                spec: readySpec,
                createdAt: "2025-01-02T00:00:00Z",
                finishedAt: "2025-01-05T00:00:00Z",
            },
            {
                resourceId: deployedId,
                status: "ready",
                spec: "services: {web: {image: nginx:earlier-finish}}",
                createdAt: "2025-01-03T00:00:00Z",
                finishedAt: "2025-01-04T00:00:00Z",
            },
            {
                resourceId: deployedId,
                status: "failed",
                spec: "services: {web: {image: nginx:failed}}",
                createdAt: "2025-01-06T00:00:00Z",
                finishedAt: "2025-01-06T01:00:00Z",
            },
            {
                resourceId: deployedId,
                status: "running",
                spec: "services: {web: {image: nginx:running}}",
                createdAt: "2025-01-07T00:00:00Z",
                finishedAt: null,
            },
            {
                resourceId: failedId,
                status: "failed",
                spec: "services: {web: {image: nginx:never-deployed}}",
                createdAt: "2025-01-08T00:00:00Z",
                finishedAt: "2025-01-08T01:00:00Z",
            },
        ];

        for (const deployment of history) {
            const id = randomUUID();
            await db.$client.query(
                `INSERT INTO deployments (id, cluster_id, resource_id, name, status, job_id, created_at, updated_at, finished_at)
                 VALUES ($1::uuid, $2, $3, 'DeployResource', $4, $1::text, $5, $5, $6)`,
                [
                    id,
                    clusterId,
                    deployment.resourceId,
                    deployment.status,
                    deployment.createdAt,
                    deployment.finishedAt,
                ],
            );
            await db.$client.query(
                `INSERT INTO resource_deployment_inputs (deployment_id, spec, prefix)
                 VALUES ($1, $2, 'migration')`,
                [id, deployment.spec],
            );
        }

        await db.$client.query(
            `INSERT INTO cluster_monitoring (cluster_id, project_id, resource_id, machine_id, encrypted_password)
             VALUES ($1, $2, $3, 'machine', 'unused'), ($4, $5, $6, 'machine', 'unused')`,
            [
                clusterId,
                projectId,
                uninitializedMonitoringId,
                initializedClusterId,
                initializedProjectId,
                initializedMonitoringId,
            ],
        );

        await db.transaction(async (tx) => {
            for (const statement of draftMigration.sql) await tx.execute(sql.raw(statement));
        });

        const migrated = await db
            .select({ id: resources.id, spec: resources.spec, draftSpec: resources.draftSpec })
            .from(resources);

        expect(migrated).toHaveLength(fixtures.length);

        for (const fixture of fixtures) {
            expect(
                migrated.find((resource) => resource.id === fixture.id),
                fixture.name,
            ).toEqual({
                id: fixture.id,
                spec: fixture.expectedSpec,
                draftSpec: fixture.spec,
            });
        }
    }, 30_000);
});
