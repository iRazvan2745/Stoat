import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { prepareMonitoring, setInitializationStatus } from "@stoat/db/initialization";
import {
    clusterMonitoring,
    clusters,
    projects,
    resources,
    type ClusterInitializationConfiguration,
} from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import template from "../../internal/monitoring/compose.yaml?raw";

describe("monitoring provisioning (PostgreSQL)", () => {
    const databaseName = `stoat_monitoring_test_${randomUUID().replaceAll("-", "")}`;
    const organizationId = randomUUID();
    const clusterId = randomUUID();

    const config: ClusterInitializationConfiguration = {
        machineId: "machine-1",
        greptimeStorage: { type: "volume", source: "greptime-data" },
        alloyStorage: { type: "bind", source: "/srv/alloy" },
        retentionDays: 14,
    };

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Monitoring', $1, now())`,
            [organizationId],
        );
    }, 30_000);

    beforeEach(async () => {
        await db.delete(clusters);
        await db.insert(clusters).values({
            id: clusterId,
            organizationId,
            name: "Monitoring cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            initializationStatus: "queued",
            initializationRequestedAt: new Date(),
            initializationConfiguration: config,
        });
    });

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("serializes concurrent provisioning into one private project, resource, and credential", async () => {
        const lock = await db.$client.connect();
        await lock.query("BEGIN");
        await lock.query("SELECT id FROM clusters WHERE id = $1 FOR UPDATE", [clusterId]);
        const passwords = ["encrypted-a", "encrypted-b", "encrypted-c", "encrypted-d"];

        const pending = Promise.allSettled(
            passwords.map((password) => prepareMonitoring(db, clusterId, password, template)),
        );

        try {
            // Force actual overlapping transactions instead of relying on scheduler timing.
            await expect
                .poll(async () => {
                    const result = await db.$client.query(
                        `SELECT count(*)::int AS waiting FROM pg_stat_activity
                     WHERE datname = current_database() AND wait_event_type = 'Lock'`,
                    );

                    return result.rows[0].waiting;
                })
                .toBe(passwords.length);
        } finally {
            await lock.query("ROLLBACK");
            lock.release();
            await pending;
        }

        const results = await pending;
        const [state] = await db.select().from(clusterMonitoring);
        expect(state).toBeDefined();
        expect(passwords).toContain(state!.encryptedPassword);
        expect(results).toEqual(passwords.map(() => ({ status: "fulfilled", value: state })));
        expect(await db.select().from(clusterMonitoring)).toEqual([state]);
        expect(await db.select().from(projects)).toEqual([
            expect.objectContaining({
                id: state!.projectId,
                clusterId,
                name: "Monitoring",
                isInternal: true,
            }),
        ]);
        expect(await db.select().from(resources)).toEqual([
            expect.objectContaining({
                id: state!.resourceId,
                projectId: state!.projectId,
                name: "Monitoring",
                type: "compose",
                spec: null,
                draftSpec: template,
                settings: config,
            }),
        ]);
        expect(state!.machineId).toBe(config.machineId);
    });

    it("reuses persisted credentials and resource snapshots on subsequent attempts", async () => {
        const first = await prepareMonitoring(db, clusterId, "original-ciphertext", template);
        const savedProjects = await db.select().from(projects);
        const savedResources = await db.select().from(resources);

        const again = await prepareMonitoring(
            db,
            clusterId,
            "replacement-ciphertext",
            "replacement-template",
        );

        expect(again).toEqual(first);
        expect(await db.select().from(clusterMonitoring)).toEqual([first]);
        expect(await db.select().from(projects)).toEqual(savedProjects);
        expect(await db.select().from(resources)).toEqual(savedResources);
    });

    it.each([
        ["resources", "draft_spec"],
        ["cluster_monitoring", "encrypted_password"],
    ])("rolls back all provisioning writes if the %s insert fails", async (table, column) => {
        // A real constraint failure exercises rollback after the preceding inserts succeeded.
        await db.$client.query(
            `ALTER TABLE "${table}" ADD CONSTRAINT reject_provisioning CHECK ("${column}" <> 'reject-provisioning')`,
        );

        try {
            await expect(
                prepareMonitoring(db, clusterId, "reject-provisioning", "reject-provisioning"),
            ).rejects.toMatchObject({
                cause: { code: "23514", constraint: "reject_provisioning" },
            });
            expect(await db.select().from(clusterMonitoring)).toEqual([]);
            expect(await db.select().from(resources)).toEqual([]);
            expect(await db.select().from(projects)).toEqual([]);
            const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
            expect(cluster).toMatchObject({
                initializationStatus: "queued",
                initializationConfiguration: config,
            });
        } finally {
            await db.$client.query(`ALTER TABLE "${table}" DROP CONSTRAINT reject_provisioning`);
        }

        const state = await prepareMonitoring(db, clusterId, "retry-ciphertext", template);
        expect(await db.select().from(clusterMonitoring)).toEqual([state]);
        expect(await db.select().from(resources)).toHaveLength(1);
        expect(await db.select().from(projects)).toHaveLength(1);
    });

    it.each(["missing cluster", "missing configuration"])(
        "rejects %s without leaving provisioning rows",
        async (missing) => {
            if (missing === "missing cluster") {
                await db.delete(clusters).where(eq(clusters.id, clusterId));
            } else {
                await db
                    .update(clusters)
                    .set({ initializationConfiguration: null })
                    .where(eq(clusters.id, clusterId));
            }

            await expect(prepareMonitoring(db, clusterId, "ciphertext", template)).rejects.toThrow(
                "Missing initialization configuration.",
            );
            expect(await db.select().from(clusterMonitoring)).toEqual([]);
            expect(await db.select().from(resources)).toEqual([]);
            expect(await db.select().from(projects)).toEqual([]);
        },
    );

    it("updates pre-ready statuses and records readiness with the internal URL", async () => {
        for (const [status, error] of [
            ["running", null],
            ["retrying", "temporary failure"],
            ["failed", "terminal failure"],
            ["running", null],
        ] as const) {
            await setInitializationStatus(db, clusterId, status, error);
            const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
            expect(cluster).toMatchObject({
                initializationStatus: status,
                initializationError: error,
                initializedAt: null,
                greptimeUrl: null,
                initializationConfiguration: config,
            });
        }

        const beforeReady = Date.now();
        await setInitializationStatus(db, clusterId, "ready", null);
        const [ready] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
        expect(ready).toMatchObject({
            initializationStatus: "ready",
            initializationError: null,
            greptimeUrl: "http://stoat-monitoring-greptimedb.internal:4006",
            initializationConfiguration: config,
        });
        expect(ready!.initializedAt).toBeInstanceOf(Date);
        expect(ready!.initializedAt!.getTime()).toBeGreaterThanOrEqual(beforeReady);
        expect(ready!.initializedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it.each(["running", "retrying", "failed", "ready"] as const)(
        "never overwrites established readiness with %s",
        async (status) => {
            const initializedAt = new Date("2025-01-01T00:00:00.000Z");
            await db
                .update(clusters)
                .set({
                    initializationStatus: "ready",
                    initializedAt,
                    greptimeUrl: "http://stoat-monitoring-greptimedb.internal:4006",
                })
                .where(eq(clusters.id, clusterId));
            const [before] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

            await setInitializationStatus(db, clusterId, status, "must-not-overwrite-ready");

            expect(await db.select().from(clusters).where(eq(clusters.id, clusterId))).toEqual([
                before,
            ]);
        },
    );
});
