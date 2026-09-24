import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createDb } from "@stoat/db";
import {
    appendDeploymentLog,
    cancelDeployment,
    createDeployment,
    getDeploymentWithLogs,
    setDeploymentStatus,
    watchDeployment,
    watchDeploymentChanges,
} from "@stoat/db/deployments";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import * as runtime from "@stoat/workflows/runtime";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { deploymentsRouter } from "../../packages/api/src/routers/cluster/deployments";

describe("deployment streaming (PostgreSQL LISTEN/NOTIFY)", () => {
    const databaseName = `stoat_stream_test_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const resourceId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let writer: ReturnType<typeof createDb>;
    let context: Context;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        writer = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('streamer', 'Streamer', 'streamer@example.test')`,
        );

        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'streamer'`,
        );

        const organizationId: string = membership.rows[0].organization_id;
        // SAFETY: authorization only reads the user identity and active organization.
        context = {
            db,
            session: {
                user: { id: "streamer" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
        await db.insert(clusters).values({
            id: clusterId,
            name: "Streaming",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "private",
            organizationId,
            initializationStatus: "running",
        });
        const projectId = randomUUID();
        await db.insert(projects).values({ id: projectId, clusterId, name: "Project" });
        await db.insert(resources).values({ id: resourceId, projectId, name: "Resource" });
    }, 30_000);

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await writer?.$client.end();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("streams external SQL writes without polling, buffers paused updates, and releases on abort", async () => {
        const deployment = await createDeployment(db, {
            clusterId,
            name: "Live",
            jobId: randomUUID(),
        });

        const controller = new AbortController();
        const stream = watchDeployment(db, deployment.id, { signal: controller.signal });

        try {
            expect((await stream.next()).value).toMatchObject({
                deployment: { id: deployment.id, status: "queued", resourceId: null },
                logs: [],
            });
            const reads = vi.spyOn(db, "select");
            const next = stream.next();
            vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads).not.toHaveBeenCalled();
            vi.useRealTimers();

            // A separate pool and raw SQL prove this is not an in-process event emitter.
            await writer.$client.query(
                `INSERT INTO deployment_logs (deployment_id, text, created_at) VALUES ($1, 'external', now())`,
                [deployment.id],
            );
            const event = (await next).value;
            expect(event).toMatchObject({ logs: [{ text: "external", metadata: {} }] });

            // Write while the consumer is paused at yield, before it starts waiting again.
            await appendDeploymentLog(writer, deployment.id, "buffered", {
                level: "debug",
                event: "build",
            });
            expect((await stream.next()).value).toMatchObject({
                logs: [{ text: "buffered", metadata: { level: "debug", event: "build" } }],
            });
            const waiting = stream.next();
            controller.abort();
            expect(await waiting).toEqual({ done: true, value: undefined });

            const listeners = await db.$client.query(
                `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN deployment_changes'`,
            );

            expect(listeners.rows).toEqual([]);
        } finally {
            controller.abort();
            await stream.return();
        }
    });

    it("releases an idle HTTP stream when only the response is cancelled", async () => {
        const handler = new RPCHandler(deploymentsRouter);

        const request = new Request("http://localhost/rpc/watchDeployments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });

        const { response } = await handler.handle(request, { prefix: "/rpc", context });
        expect(response?.headers.get("content-type")).toContain("text/event-stream");
        const reader = response!.body!.getReader();
        const decoder = new TextDecoder();
        let output = "";

        while (!output.includes("deploymentId")) {
            const event = await reader.read();
            expect(event.done).toBe(false);
            output += decoder.decode(event.value);
        }

        const pending = reader.read();
        await reader.cancel();
        await pending;
        expect(request.signal.aborted).toBe(false);
        await expect
            .poll(async () => {
                const listeners = await db.$client.query(
                    `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN deployment_list_changes'`,
                );

                return listeners.rowCount;
            })
            .toBe(0);
    });

    it("replays beyond 2000 in ascending cursor batches, hides snapshots, and drains terminal logs", async () => {
        const deployment = await createDeployment(db, {
            clusterId,
            resourceId,
            name: "Replay",
            jobId: randomUUID(),
        });

        await db.insert(resourceDeploymentInputs).values({
            deploymentId: deployment.id,
            spec: "COMPOSE_SECRET",
            prefix: "private-prefix",
        });
        await writer.$client.query(
            `INSERT INTO deployment_logs (deployment_id, text, created_at)
             SELECT $1, 'line-' || n, now() FROM generate_series(1, 4005) n`,
            [deployment.id],
        );
        await setDeploymentStatus(writer, deployment.id, "ready");

        const events = [];

        for await (const event of watchDeployment(db, deployment.id)) events.push(event);
        expect(events.map((event) => event.logs.length)).toEqual([2000, 2000, 5]);
        expect(events.map((event) => event.complete)).toEqual([false, false, true]);
        const logs = events.flatMap((event) => event.logs);
        expect(logs).toHaveLength(4005);
        expect(logs.every((line, index) => index === 0 || line.id > logs[index - 1]!.id)).toBe(
            true,
        );
        expect(events.every((event) => event.deployment.status === "ready")).toBe(true);
        expect(JSON.stringify(events)).not.toContain("COMPOSE_SECRET");
        expect(await getDeploymentWithLogs(db, deployment.id)).not.toHaveProperty("spec");

        const resumed = [];

        for await (const event of watchDeployment(db, deployment.id, { afterId: logs[3999]!.id }))
            resumed.push(...event.logs);
        expect(resumed.map((line) => line.id)).toEqual(logs.slice(4000).map((line) => line.id));

        await db.delete(deployments).where(eq(deployments.id, deployment.id));
        expect(
            await db
                .select()
                .from(resourceDeploymentInputs)
                .where(eq(resourceDeploymentInputs.deploymentId, deployment.id)),
        ).toEqual([]);
    });

    it("wakes for status changes and cannot resurrect cancelled deployments", async () => {
        const deployment = await createDeployment(db, {
            clusterId,
            name: "Cancel",
            jobId: randomUUID(),
        });

        const stream = watchDeployment(db, deployment.id);

        try {
            await stream.next();
            const next = stream.next();
            await cancelDeployment(writer, deployment.id);
            expect((await next).value).toMatchObject({
                deployment: { status: "cancelled" },
                logs: [],
            });
            expect((await stream.next()).done).toBe(true);
            const frozen = await getDeploymentWithLogs(db, deployment.id);

            for (const status of ["queued", "running", "ready", "failed", "cancelled"] as const) {
                await setDeploymentStatus(writer, deployment.id, status, "late worker error");
            }

            expect(await getDeploymentWithLogs(db, deployment.id)).toEqual(frozen);
        } finally {
            await stream.return();
        }
    });

    it("delivers final committed logs before ending and fails promptly if LISTEN disconnects", async () => {
        const deployment = await createDeployment(db, {
            clusterId,
            name: "Final logs",
            jobId: randomUUID(),
        });

        const stream = watchDeployment(db, deployment.id);

        try {
            await stream.next();
            const next = stream.next();

            await writer.transaction(async (tx) => {
                await tx.execute(
                    // Both triggers fire in one commit; NOTIFY may coalesce their payloads.
                    sql`INSERT INTO deployment_logs (deployment_id, text, created_at)
                        VALUES (${deployment.id}, 'final output', now())`,
                );
                await tx
                    .update(deployments)
                    .set({ status: "failed" })
                    .where(eq(deployments.id, deployment.id));
            });
            expect((await next).value).toMatchObject({
                deployment: { status: "failed" },
                logs: [{ text: "final output" }],
            });
            expect((await stream.next()).done).toBe(true);
        } finally {
            await stream.return();
        }

        const changes = watchDeploymentChanges(db);

        try {
            await changes.next();
            const disconnected = expect(changes.next()).rejects.toThrow();

            await writer.$client.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = current_database() AND query = 'LISTEN deployment_changes'`,
            );
            await disconnected;
        } finally {
            await changes.return();
        }
    });

    it("finishes cleanly when aborted during connection setup", async () => {
        const controller = new AbortController();

        const changes = watchDeploymentChanges(db, {
            signal: controller.signal,
            includeLogs: false,
        });

        const connecting = changes.next();

        // Abort synchronously, before pg can finish connecting or execute LISTEN.
        controller.abort();
        expect(await connecting).toEqual({ done: true, value: undefined });
    });

    it("authorizes list changes, ignores logs, and buffers status changes and deletes", async () => {
        const foreignOrg = randomUUID();
        const foreignCluster = randomUUID();
        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Foreign', $1, now())`,
            [foreignOrg],
        );
        await db.insert(clusters).values({
            id: foreignCluster,
            name: "Foreign",
            sidecarUrl: "http://foreign.test",
            sidecarToken: "secret",
            organizationId: foreignOrg,
        });

        const foreign = await createDeployment(db, {
            clusterId: foreignCluster,
            name: "Foreign",
            jobId: randomUUID(),
        });

        const denied = await call(
            deploymentsRouter.streamDeployment,
            { deploymentId: foreign.id },
            { context },
        );

        await expect(denied.next()).rejects.toMatchObject({ code: "NOT_FOUND" });

        const listeners = await db.$client.query(
            `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN deployment_changes'`,
        );

        expect(listeners.rows).toEqual([]);

        const statusDeployment = await createDeployment(writer, {
            clusterId,
            name: "Status changes",
            jobId: randomUUID(),
        });

        const controller = new AbortController();

        const changes = await call(deploymentsRouter.watchDeployments, undefined, {
            context,
            signal: controller.signal,
        });

        try {
            expect((await changes.next()).value).toEqual({ deploymentId: null });
            // Write after LISTEN is ready, but before the consumer starts waiting again.
            await setDeploymentStatus(writer, foreign.id, "running");

            const own = await createDeployment(writer, {
                clusterId,
                name: "Own",
                jobId: randomUUID(),
            });

            expect((await changes.next()).value).toEqual({ deploymentId: own.id });

            const statusChange = changes.next();
            await appendDeploymentLog(writer, own.id, "progress must not invalidate the list");
            await setDeploymentStatus(writer, statusDeployment.id, "running");
            // Different IDs make this deterministic without a sleep: a log wakeup would
            // precede the status notification and incorrectly yield own.id instead.
            expect((await statusChange).value).toEqual({ deploymentId: statusDeployment.id });

            const deleted = changes.next();
            await writer.delete(deployments).where(eq(deployments.id, own.id));
            expect((await deleted).value).toEqual({ deploymentId: own.id });
        } finally {
            controller.abort();
            await changes.return();
        }

        const alreadyAborted = watchDeploymentChanges(db, { signal: controller.signal });
        expect((await alreadyAborted.next()).done).toBe(true);

        const remainingListeners = await db.$client.query(
            `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
             AND query IN ('LISTEN deployment_changes', 'LISTEN deployment_list_changes')`,
        );

        expect(remainingListeners.rows).toEqual([]);
    });

    it("persists cancellation before stopping the correct job and leaves resource cluster initialization alone", async () => {
        const cancel = vi
            .spyOn(runtime, "cancelDeploymentJob")
            .mockImplementation(async (jobId) => {
                const [row] = await writer
                    .select()
                    .from(deployments)
                    .where(eq(deployments.jobId, jobId));

                expect(row?.status).toBe("cancelled");
            });

        const deployment = await createDeployment(db, {
            clusterId,
            resourceId,
            name: "Resource",
            jobId: randomUUID(),
        });

        const stream = await call(
            deploymentsRouter.streamDeployment,
            { deploymentId: deployment.id },
            { context },
        );

        try {
            expect((await stream.next()).value).toMatchObject({
                canCancel: true,
                deployment: { resourceId },
            });
        } finally {
            await stream.return();
        }

        await call(
            deploymentsRouter.cancelDeployment,
            { deploymentId: deployment.id },
            { context },
        );
        expect(cancel).toHaveBeenCalledWith(deployment.jobId, "DeployResource");
        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));
        expect(cluster?.initializationStatus).toBe("running");

        const initialization = await createDeployment(db, {
            clusterId,
            name: "InitializeCluster",
            jobId: randomUUID(),
        });

        await call(
            deploymentsRouter.cancelDeployment,
            { deploymentId: initialization.id },
            { context },
        );
        expect(cancel).toHaveBeenCalledWith(initialization.jobId, "InitializeCluster");

        const [cancelledCluster] = await db
            .select()
            .from(clusters)
            .where(eq(clusters.id, clusterId));

        expect(cancelledCluster?.initializationStatus).toBe("failed");
    });
});
