import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import {
    clusters,
    clusterMonitoring,
    deployments,
    projects,
    resources,
} from "@stoat/db/schema/index";
import { encryptMonitoringPassword } from "@stoat/workflows/secrets";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Context } from "../../packages/api/src/context";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { projectsRouter } from "../../packages/api/src/routers/projects";
import { resourcesRouter } from "../../packages/api/src/routers/resources";

vi.mock("@stoat/uncloud", async (importOriginal) => {
    const original = await importOriginal<typeof import("@stoat/uncloud")>();

    return {
        ...original,
        ucClient: () => ({
            GET: async (path: string) => {
                const response = new Response(null, { status: 200 });

                if (path === "/api/v1/machines") {
                    return {
                        response,
                        data: { items: [{ id: "machine-1", name: "First", state: "up" }] },
                    };
                }

                if (path === "/api/v1/volumes") return { response, data: { items: [] } };

                return {
                    response,
                    data: { status: "healthy", machines: [], links: [], issues: [] },
                };
            },
        }),
    };
});

describe("cluster initialization API (PostgreSQL)", () => {
    const databaseName = `stoat_initialization_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    let organizationId: string;

    const config = {
        machineId: "machine-1",
        greptimeStorage: { type: "volume" as const, source: "stoat-monitoring-greptime" },
        alloyStorage: { type: "volume" as const, source: "stoat-monitoring-alloy" },
        retentionDays: 14,
    };

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('initializer', 'Initializer', 'initialize@example.test')`,
        );

        const member = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'initializer'`,
        );

        organizationId = member.rows[0].organization_id;
        // SAFETY: router authorization reads only the identity and active organization.
        context = {
            db,
            session: {
                user: { id: "initializer" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("requires explicit initialization, persists choices atomically, and retries without changing them", async () => {
        const added = await call(
            clusterRouter.createCluster,
            {
                name: "Test",
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "never-return-this",
            },
            { context },
        );

        const clusterId = added.id!;
        const [before] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
        expect(before).toMatchObject({
            initializationStatus: "uninitialized",
            initializationRequestedAt: null,
        });
        await call(
            clusterRouter.initializeCluster,
            { clusterId, configuration: config },
            { context },
        );
        const [queued] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
        expect(queued).toMatchObject({
            initializationStatus: "queued",
            initializationConfiguration: config,
        });
        expect(queued?.initializationRequestedAt).toBeInstanceOf(Date);
        await expect(
            call(
                clusterRouter.initializeCluster,
                { clusterId, configuration: config },
                { context },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
            call(clusterRouter.deleteCluster, { clusterId }, { context }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await db
            .update(clusters)
            .set({ initializationStatus: "failed" })
            .where(eq(clusters.id, clusterId));
        await call(clusterRouter.retryInitialization, { clusterId }, { context });
        const [retried] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
        expect(retried?.initializationConfiguration).toEqual(config);
        const result = await call(clusterRouter.getCluster, { clusterId }, { context });
        expect(result.canInitialize).toBe(true);
        expect(result).not.toHaveProperty("sidecarToken");
    });

    it("hides internal projects, resources, and project counts, including direct-ID access", async () => {
        const clusterId = randomUUID();
        const projectId = randomUUID();
        await db.insert(clusters).values({
            id: clusterId,
            name: "Private",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db
            .insert(projects)
            .values({ id: projectId, clusterId, name: "Monitoring", isInternal: true });
        await db
            .insert(resources)
            .values({ id: randomUUID(), projectId, name: "Private spec", spec: "private" });
        expect(await call(projectsRouter.listProjects, undefined, { context })).toEqual([]);
        expect(
            (await call(clusterRouter.getCluster, { clusterId }, { context })).projectCount,
        ).toBe(0);
        await expect(
            call(resourcesRouter.listResources, { projectId }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
            call(resourcesRouter.createResource, { projectId, name: "Injected" }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("records an InitializeCluster deployment with logs for every request", async () => {
        const added = await call(
            clusterRouter.createCluster,
            { name: "Deployments", sidecarUrl: "http://sidecar.test", sidecarToken: "secret" },
            { context },
        );

        const clusterId = added.id!;

        const first = await call(
            clusterRouter.initializeCluster,
            { clusterId, configuration: config },
            { context },
        );

        expect(first.deploymentId).toBeDefined();
        const listed = await call(clusterRouter.listDeployments, { clusterId }, { context });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            name: "InitializeCluster",
            status: "queued",
            clusterId,
        });

        const detail = await call(
            clusterRouter.getDeployment,
            { deploymentId: first.deploymentId! },
            { context },
        );

        expect(detail.logs).toEqual([]);
        expect(detail.configuration).toEqual(config);
        await db
            .update(clusters)
            .set({ initializationStatus: "failed" })
            .where(eq(clusters.id, clusterId));

        const second = await call(clusterRouter.retryInitialization, { clusterId }, { context });

        expect(second.deploymentId).toBeDefined();
        expect(second.deploymentId).not.toBe(first.deploymentId);
        expect(await call(clusterRouter.listDeployments, { clusterId }, { context })).toHaveLength(
            2,
        );
        await expect(
            call(clusterRouter.getDeployment, { deploymentId: randomUUID() }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        // Deployments in other organizations stay invisible, even by id.
        const foreignOrg = randomUUID();
        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Foreign', $2, now())`,
            [foreignOrg, `foreign-${foreignOrg.slice(0, 8)}`],
        );
        const foreignCluster = randomUUID();
        const foreignDeployment = randomUUID();
        await db.insert(clusters).values({
            id: foreignCluster,
            name: "Foreign",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId: foreignOrg,
        });
        await db.insert(deployments).values({
            id: foreignDeployment,
            clusterId: foreignCluster,
            name: "InitializeCluster",
            jobId: `foreign:${randomUUID()}`,
        });
        await expect(
            call(clusterRouter.getDeployment, { deploymentId: foreignDeployment }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
            call(clusterRouter.listDeployments, { clusterId: foreignCluster }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const all = await call(clusterRouter.listAllDeployments, {}, { context });
        expect(all.items.some((d) => d.id === first.deploymentId)).toBe(true);
        expect(all.items.some((d) => d.id === second.deploymentId)).toBe(true);
        expect(all.items.some((d) => d.id === foreignDeployment)).toBe(false);
        expect(all.items.find((d) => d.id === first.deploymentId)?.clusterName).toBe("Deployments");

        const readyOnly = await call(
            clusterRouter.listAllDeployments,
            { status: "ready" },
            { context },
        );

        expect(readyOnly.items).toEqual([]);
        expect(readyOnly.total).toBe(0);

        const cancelled = await call(
            clusterRouter.cancelDeployment,
            { deploymentId: second.deploymentId! },
            { context },
        );

        expect(cancelled).toMatchObject({ id: second.deploymentId, status: "cancelled" });

        const afterCancel = await call(
            clusterRouter.getDeployment,
            { deploymentId: second.deploymentId! },
            { context },
        );

        expect(afterCancel.status).toBe("cancelled");
        expect(afterCancel.canCancel).toBe(true);
        await expect(
            call(
                clusterRouter.cancelDeployment,
                { deploymentId: second.deploymentId! },
                { context },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
            call(clusterRouter.cancelDeployment, { deploymentId: randomUUID() }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });

        const [failedCluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        expect(failedCluster?.initializationStatus).toBe("failed");
    });

    it("exposes monitoring connection details, gating the password to admins", async () => {
        const added = await call(
            clusterRouter.createCluster,
            { name: "Monitoring", sidecarUrl: "http://sidecar.test", sidecarToken: "secret" },
            { context },
        );

        const clusterId = added.id!;
        expect(
            await call(clusterRouter.getMonitoringConnection, { clusterId }, { context }),
        ).toEqual({ configured: false });
        await call(
            clusterRouter.initializeCluster,
            { clusterId, configuration: config },
            { context },
        );
        const projectId = randomUUID();
        const resourceId = randomUUID();
        await db
            .insert(projects)
            .values({ id: projectId, clusterId, name: "Monitoring", isInternal: true });
        await db.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Monitoring",
            type: "compose",
            spec: "template",
        });
        const secret = "test-app-secret-with-at-least-32-chars";
        await db.insert(clusterMonitoring).values({
            clusterId,
            projectId,
            resourceId,
            machineId: "machine-1",
            encryptedPassword: encryptMonitoringPassword("greptime-pw", secret, clusterId),
        });
        const previous = process.env.BETTER_AUTH_SECRET;
        process.env.BETTER_AUTH_SECRET = secret;

        try {
            const conn = await call(
                clusterRouter.getMonitoringConnection,
                { clusterId },
                { context },
            );

            expect(conn).toMatchObject({
                configured: true,
                database: "monitoring",
                username: "stoat",
                ingestUrl: "http://stoat-monitoring-greptimedb.internal:4006",
                httpUrl: "http://stoat-monitoring-greptimedb.internal:4000",
                password: "greptime-pw",
                canReveal: true,
            });
        } finally {
            if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
            else process.env.BETTER_AUTH_SECRET = previous;
        }

        process.env.BETTER_AUTH_SECRET = `${secret}-rotated`;

        try {
            const rotated = await call(
                clusterRouter.getMonitoringConnection,
                { clusterId },
                { context },
            );

            expect(rotated).toMatchObject({
                configured: true,
                password: null,
                canReveal: true,
            });
        } finally {
            if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
            else process.env.BETTER_AUTH_SECRET = previous;
        }

        await expect(
            call(clusterRouter.getMonitoringConnection, { clusterId: randomUUID() }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it.each(["initialize", "retry"] as const)(
        "rolls back the %s request if deployment history cannot be persisted",
        async (action) => {
            const clusterId = randomUUID();
            const requestedAt = new Date("2026-01-01T00:00:00Z");
            await db.insert(clusters).values({
                id: clusterId,
                organizationId,
                name: "Atomic request",
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "secret",
                initializationStatus: action === "retry" ? "failed" : "uninitialized",
                initializationConfiguration: action === "retry" ? config : null,
                initializationRequestedAt: action === "retry" ? requestedAt : null,
                initializationError: action === "retry" ? "Previous failure" : null,
            });
            const before = await db.select().from(clusters).where(eq(clusters.id, clusterId));
            // The UUID is generated here, never supplied by a request.
            await db.$client.query(
                `ALTER TABLE deployments ADD CONSTRAINT reject_test_deployment CHECK (cluster_id <> '${clusterId}') NOT VALID`,
            );

            try {
                await expect(
                    action === "initialize"
                        ? call(
                              clusterRouter.initializeCluster,
                              { clusterId, configuration: config },
                              { context },
                          )
                        : call(clusterRouter.retryInitialization, { clusterId }, { context }),
                ).rejects.toThrow();
                expect(await db.select().from(clusters).where(eq(clusters.id, clusterId))).toEqual(
                    before,
                );
                expect(
                    await db.select().from(deployments).where(eq(deployments.clusterId, clusterId)),
                ).toEqual([]);
            } finally {
                await db.$client.query(
                    "ALTER TABLE deployments DROP CONSTRAINT reject_test_deployment",
                );
            }
        },
    );

    it.each(["initialize", "retry"] as const)(
        "accepts exactly one concurrent %s request and records its matching deployment",
        async (action) => {
            const clusterId = randomUUID();
            await db.insert(clusters).values({
                id: clusterId,
                organizationId,
                name: "Concurrent request",
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "secret",
                initializationStatus: action === "retry" ? "failed" : "uninitialized",
                initializationConfiguration: action === "retry" ? config : null,
            });

            const request = () =>
                action === "initialize"
                    ? call(
                          clusterRouter.initializeCluster,
                          { clusterId, configuration: config },
                          { context },
                      )
                    : call(clusterRouter.retryInitialization, { clusterId }, { context });

            const results = await Promise.allSettled([request(), request()]);
            expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(results.find((result) => result.status === "rejected")).toMatchObject({
                reason: { code: "CONFLICT" },
            });
            const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

            const history = await db
                .select()
                .from(deployments)
                .where(eq(deployments.clusterId, clusterId));

            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({
                status: "queued",
                configuration: config,
                jobId: `${clusterId}:${cluster!.initializationRequestedAt!.toISOString()}`,
            });
            expect(cluster).toMatchObject({
                initializationStatus: "queued",
                initializationConfiguration: config,
            });
        },
    );

    it.each([
        "/var/lib//docker",
        "/var/lib//containerd/data",
        "/var/lib/docker//volumes",
        "/srv//data",
        "/srv/data/",
        "/srv/./data",
        "/srv/data/../other",
        "/srv/",
    ])("rejects noncanonical or protected storage %s without queuing work", async (source) => {
        const clusterId = randomUUID();
        await db.insert(clusters).values({
            id: clusterId,
            organizationId,
            name: "Storage validation",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
        });
        await expect(
            call(
                clusterRouter.initializeCluster,
                {
                    clusterId,
                    configuration: { ...config, greptimeStorage: { type: "bind", source } },
                },
                { context },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
        expect(cluster).toMatchObject({
            initializationStatus: "uninitialized",
            initializationRequestedAt: null,
        });
        expect(
            await db.select().from(deployments).where(eq(deployments.clusterId, clusterId)),
        ).toEqual([]);
    });

    it.each(["owner", "admin", "member", "member, admin"])(
        "reveals monitoring passwords only to privileged roles: %s",
        async (role) => {
            const clusterId = randomUUID();
            const projectId = randomUUID();
            const resourceId = randomUUID();
            const userId = randomUUID();
            const secret = "test-monitoring-role-secret-at-least-32-characters";
            await db.$client.query(
                `INSERT INTO "user" (id, name, email) VALUES ($1, 'Role test', $2)`,
                [userId, `${userId}@test.example`],
            );
            await db.$client.query(
                `INSERT INTO member (id, user_id, organization_id, role, created_at) VALUES ($1, $2, $3, $4, now())`,
                [randomUUID(), userId, organizationId, role],
            );
            await db.insert(clusters).values({
                id: clusterId,
                organizationId,
                name: "Secret roles",
                sidecarUrl: "http://sidecar.test",
                sidecarToken: "private-sidecar-token",
            });
            await db
                .insert(projects)
                .values({ id: projectId, clusterId, name: "Monitoring", isInternal: true });
            await db.insert(resources).values({ id: resourceId, projectId, name: "Monitoring" });
            await db.insert(clusterMonitoring).values({
                clusterId,
                projectId,
                resourceId,
                machineId: "machine-1",
                encryptedPassword: encryptMonitoringPassword(
                    "private-monitoring-password",
                    secret,
                    clusterId,
                ),
            });

            // SAFETY: authorization reads the test user's identity and selected organization only.
            const roleContext = {
                db,
                session: {
                    user: { id: userId },
                    session: { activeOrganizationId: organizationId },
                },
            } as Context;

            vi.stubEnv("BETTER_AUTH_SECRET", secret);

            try {
                const connection = await call(
                    clusterRouter.getMonitoringConnection,
                    { clusterId },
                    { context: roleContext },
                );

                const canReveal = role !== "member";
                expect(connection).toMatchObject({
                    configured: true,
                    canReveal,
                    password: canReveal ? "private-monitoring-password" : null,
                });
                expect(connection).not.toHaveProperty("encryptedPassword");
                expect(connection).not.toHaveProperty("sidecarToken");
            } finally {
                vi.unstubAllEnvs();
            }
        },
    );

    it("rejects dangerous storage paths, missing machines, and ordinary members", async () => {
        const added = await call(
            clusterRouter.createCluster,
            { name: "Validation", sidecarUrl: "http://sidecar.test", sidecarToken: "secret" },
            { context },
        );

        for (const source of [
            "/",
            "/etc",
            "/var/lib/docker",
            "/srv/../etc",
            "/srv/data${SECRET}",
        ]) {
            await expect(
                call(
                    clusterRouter.initializeCluster,
                    {
                        clusterId: added.id!,
                        configuration: { ...config, greptimeStorage: { type: "bind", source } },
                    },
                    { context },
                ),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        }

        await expect(
            call(
                clusterRouter.initializeCluster,
                {
                    clusterId: added.id!,
                    configuration: { ...config, machineId: "other-cluster-machine" },
                },
                { context },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await db.$client.query(`UPDATE member SET role = 'member' WHERE user_id = 'initializer'`);
        await expect(
            call(clusterRouter.getInitializationOptions, { clusterId: added.id! }, { context }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
            call(
                clusterRouter.initializeCluster,
                { clusterId: added.id!, configuration: config },
                { context },
            ),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
