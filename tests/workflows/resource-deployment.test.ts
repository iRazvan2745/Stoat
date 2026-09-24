import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { cancelDeployment, getDeploymentWithLogs, watchDeployment } from "@stoat/db/deployments";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Effect, Layer, Predicate } from "effect";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import { parse } from "yaml";
import {
    deployResource,
    RESOURCE_FAILURE_MESSAGE,
} from "../../packages/workflows/src/deploy-resource";
import {
    cancelDeploymentJob,
    DeployResource,
    InitializeCluster,
    JobStoreLive,
    MonitoringWorkerLive,
    pollInitializationOutbox,
    queueResourceDeployment,
} from "../../packages/workflows/src/runtime";

describe("resource deployment worker", () => {
    const databaseName = `stoat_resource_test_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const resourceId = randomUUID();
    const secret = "never-persist-this-secret";
    const token = "different-sidecar-bearer-token";
    const sidecarError = `Cannot pull nginx:missing: manifest unknown (credential ${secret}).`;
    const httpError = `load compose file: service web references undefined volume assets. ${"diagnostic ".repeat(500)}Token ${token}; password ${secret}; end of diagnostic.`;
    const spec = `services:\n  web:\n    image: nginx\n    environment:\n      DB_HOST: db\n      PASSWORD: ${secret}\n    depends_on: [db]\n  db:\n    image: postgres\n    volumes: [data:/data]\nvolumes:\n  data: {}\n`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let other: ReturnType<typeof createDb>;
    let worker: Promise<void> | undefined;
    const controller = new AbortController();

    let mode:
        | "success"
        | "missing"
        | "error"
        | "progress-error"
        | "trailing-error"
        | "http-error"
        | "hang"
        | "pause" = "success";

    let failures = 0;
    let requestCount = 0;
    let requestBody = "";
    let authorization: string | undefined;
    let received = Promise.withResolvers<void>();
    let closed = Promise.withResolvers<void>();
    let finish = Promise.withResolvers<void>();

    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requestBody = Buffer.concat(chunks).toString();
        authorization = request.headers.authorization;
        requestCount++;
        response.on("close", () => closed.resolve());

        if (mode === "http-error") {
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: httpError }));

            return;
        }

        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
            `data: ${JSON.stringify({ type: "plan", operations: [{ action: "run", resource: "container", service: "web", image: "nginx:alpine", machine: "worker-1", name: token }] })}\n\n`,
        );
        response.write(
            `data: ${JSON.stringify({ type: "progress", phase: "working", percent: 42, id: "Image nginx:alpine on worker-1", parentId: "web", statusText: `Downloading ${secret}`, text: "\u001b[32mPulling layers\u001b[0m" })}\n\n`,
        );
        received.resolve();

        if (mode === "hang") return;

        if (mode === "pause") await finish.promise;

        if (mode === "error" || failures-- > 0) {
            response.end(`data: ${JSON.stringify({ type: "error", error: sidecarError })}\n\n`);

            return;
        }

        response.write(
            `data: ${JSON.stringify({ type: "progress", phase: mode === "progress-error" || mode === "trailing-error" ? "error" : "done", statusText: `Pull finished ${secret}` })}\n\n`,
        );

        if (mode === "trailing-error") {
            response.write(
                `data: {"type":"progress","phase":"done","text":"Cleaning up failed container"}\n\n`,
            );
            response.end(`data: ${JSON.stringify({ type: "error", error: sidecarError })}\n\n`);

            return;
        }

        response.end(
            mode === "missing" ? "" : `data: {"type":"complete","status":"${secret}"}\n\n`,
        );
    });

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        vi.stubEnv("DATABASE_URL", url.toString());
        db = createDb({ DATABASE_URL: url.toString() });
        other = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('deployer', 'Deployer', 'deployer@example.test')`,
        );

        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'deployer'`,
        );

        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();

        if (!address || Predicate.isString(address)) throw new Error("No test sidecar address");
        await db.insert(clusters).values({
            id: clusterId,
            name: "Resource worker",
            sidecarUrl: `http://127.0.0.1:${address.port}`,
            sidecarToken: token,
            organizationId: membership.rows[0].organization_id,
            initializationStatus: "ready",
        });
        await db.insert(projects).values({ id: projectId, clusterId, name: "Project" });
        await db
            .insert(resources)
            .values({ id: resourceId, projectId, name: "Resource", draftSpec: spec });
        worker = Effect.runPromise(Layer.launch(MonitoringWorkerLive), {
            signal: controller.signal,
        }).then(
            () => {},
            (error) => {
                if (!controller.signal.aborted) throw error;
            },
        );
    }, 30_000);

    beforeEach(async () => {
        await db
            .update(resources)
            .set({ spec: null, draftSpec: spec })
            .where(eq(resources.id, resourceId));
    });

    afterEach(() => {
        mode = "success";
        failures = 0;
        received = Promise.withResolvers<void>();
        closed = Promise.withResolvers<void>();
        finish.resolve();
        finish = Promise.withResolvers<void>();
    });

    afterAll(async () => {
        controller.abort();
        await worker;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await other?.$client.end();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
            await admin.$client.end();
        }

        vi.unstubAllEnvs();
    });

    async function snapshot() {
        const id = randomUUID();
        await db.transaction(async (tx) => {
            await tx
                .insert(deployments)
                .values({ id, jobId: id, clusterId, resourceId, name: "DeployResource" });
            await tx
                .insert(resourceDeploymentInputs)
                .values({ deploymentId: id, spec, prefix: "project-resource" });
        });

        return id;
    }

    async function terminal(id: string) {
        // LISTEN/NOTIFY, not log polling. The final status must include every final log.
        const events = await Array.fromAsync(
            watchDeployment(db, id, { signal: AbortSignal.timeout(15_000) }),
        );

        const logs = events.flatMap((event) => event.logs);
        const saved = await getDeploymentWithLogs(db, id);
        expect(logs).toEqual(saved!.logs);
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(JSON.stringify(saved)).not.toContain(token);

        return { status: events.at(-1)?.deployment.status, error: saved?.error, logs };
    }

    it("enqueues immediately, formats the private snapshot on pickup, and streams all sanitized progress", async () => {
        const id = await snapshot();
        const count = requestCount;
        await queueResourceDeployment(id);
        await queueResourceDeployment(id);
        const result = await terminal(id);
        expect(result.status).toBe("ready");
        expect(
            await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
        ).toMatchObject({ spec, draftSpec: spec });
        expect(result.logs.at(-1)?.metadata).toEqual({ level: "info", event: "ready" });
        expect(result.logs).toContainEqual(
            expect.objectContaining({
                text: "web | Image nginx:alpine on worker-1 | Pulling layers | Downloading [REDACTED] (42%)",
                metadata: { level: "info", event: "progress" },
            }),
        );
        expect(result.logs.filter((log) => log.metadata.event === "progress")).toHaveLength(2);
        expect(result.logs).toContainEqual(
            expect.objectContaining({
                text: "run container [REDACTED] web nginx:alpine worker-1",
                metadata: { level: "info", event: "plan" },
            }),
        );
        expect(requestCount).toBe(count + 1);
        expect(authorization).toBe(`Bearer ${token}`);
        const body = JSON.parse(requestBody);
        expect(body.options).toEqual({ skipHealth: false });
        const compose = parse(Buffer.from(body.compose, "base64").toString());
        expect(Object.keys(compose.services)).toEqual([
            "project-resource-web",
            "project-resource-db",
        ]);
        expect(compose.services["project-resource-web"].environment).toEqual({
            DB_HOST: "project-resource-db",
            PASSWORD: secret,
        });
        expect(compose.services["project-resource-db"].volumes).toEqual([
            "project-resource-data:/data",
        ]);

        const jobs = await db.$client.query(
            `SELECT payload, attempts_max FROM effect_mq_jobs WHERE id = $1`,
            [`DeployResource/${id}`],
        );

        expect(jobs.rows).toEqual([{ payload: { deploymentId: id }, attempts_max: 5 }]);
    });

    it("recovers a queued snapshot through the existing idempotent outbox sweep", async () => {
        const id = await snapshot();
        await Effect.runPromise(pollInitializationOutbox().pipe(Effect.provide(JobStoreLive)));
        await Effect.runPromise(pollInitializationOutbox().pipe(Effect.provide(JobStoreLive)));
        expect((await terminal(id)).status).toBe("ready");

        const jobs = await db.$client.query(`SELECT id FROM effect_mq_jobs WHERE id = $1`, [
            `DeployResource/${id}`,
        ]);

        expect(jobs.rowCount).toBe(1);
    });

    it.each([false, true])(
        "preserves concurrent draft edits when completion is cancelled: %s",
        async (cancelled) => {
            mode = "pause";
            const id = await snapshot();
            const attempt = deployResource(db, id, new AbortController().signal);

            try {
                await received.promise;
                expect(
                    await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
                ).toMatchObject({ spec: null, draftSpec: spec });
                const draftSpec = "services:\n  next:\n    image: nginx:alpine\n";
                await other
                    .update(resources)
                    .set({ draftSpec })
                    .where(eq(resources.id, resourceId));

                if (cancelled) await cancelDeployment(other, id);
                finish.resolve();
                await attempt;
                expect(
                    await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
                ).toMatchObject({ spec: cancelled ? null : spec, draftSpec });
                expect((await getDeploymentWithLogs(db, id))?.status).toBe(
                    cancelled ? "cancelled" : "ready",
                );
            } finally {
                finish.resolve();
                await attempt;
            }
        },
    );

    it("rolls back ready status and its log if publishing the deployed spec fails", async () => {
        const id = await snapshot();
        await db.$client.query(
            "ALTER TABLE resources ADD CONSTRAINT reject_spec CHECK (spec IS NULL)",
        );

        try {
            await expect(deployResource(db, id, new AbortController().signal)).rejects.toThrow(
                RESOURCE_FAILURE_MESSAGE,
            );
            const result = await getDeploymentWithLogs(db, id);
            expect(result?.status).toBe("running");
            expect(result?.logs.some((log) => log.metadata.event === "ready")).toBe(false);
            expect(
                await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
            ).toMatchObject({ spec: null, draftSpec: spec });
        } finally {
            await db.$client.query("ALTER TABLE resources DROP CONSTRAINT reject_spec");
        }

        await deployResource(db, id, new AbortController().signal);
        expect((await getDeploymentWithLogs(db, id))?.status).toBe("ready");
        expect(
            await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
        ).toMatchObject({ spec, draftSpec: spec });
    });

    it.each(["missing", "error", "progress-error", "trailing-error", "http-error"] as const)(
        "fails safely when sidecar result is %s",
        async (result) => {
            mode = result;
            const previousSpec = "services:\n  old:\n    image: nginx\n";
            await db
                .update(resources)
                .set({ spec: previousSpec })
                .where(eq(resources.id, resourceId));
            const id = await snapshot();
            await Effect.runPromise(
                DeployResource.enqueue({ deploymentId: id }, { attempts: 1 }).pipe(
                    Effect.provide(JobStoreLive),
                ),
            );
            const outcome = await terminal(id);
            expect(outcome.status).toBe("failed");

            const reason = {
                missing: "Uncloud stream ended without deployment completion confirmation.",
                error: sidecarError.replaceAll(secret, "[REDACTED]"),
                "progress-error": "Pull finished [REDACTED]",
                "trailing-error": sidecarError.replaceAll(secret, "[REDACTED]"),
                "http-error": `Uncloud HTTP 500: ${httpError.replaceAll(secret, "[REDACTED]").replaceAll(token, "[REDACTED]")}`,
            }[result];

            expect(outcome.error).toBe(reason);
            expect(
                await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
            ).toMatchObject({ spec: previousSpec, draftSpec: spec });
            expect(outcome.logs.at(-1)).toMatchObject({
                text: reason,
                metadata: { level: "error", event: "failed" },
            });

            if (result === "trailing-error") {
                expect(outcome.logs).toContainEqual(
                    expect.objectContaining({ text: "Cleaning up failed container" }),
                );
            }

            const job = await db.$client.query(
                `SELECT state, failed_reason, exit FROM effect_mq_jobs WHERE id = $1`,
                [`DeployResource/${id}`],
            );

            expect(job.rows[0].state).toBe("failed");
            expect(JSON.stringify(job.rows)).not.toContain(secret);
            expect(JSON.stringify(job.rows)).not.toContain(token);
            const cluster = await db.select().from(clusters).where(eq(clusters.id, clusterId));
            expect(cluster[0]?.initializationStatus).toBe("ready");
        },
    );

    it("retries without publishing a terminal failure and then reaches ready", async () => {
        failures = 1;
        const id = await snapshot();
        await Effect.runPromise(
            DeployResource.enqueue(
                { deploymentId: id },
                {
                    attempts: 2,
                    backoff: { type: "fixed", delay: "100 millis" },
                },
            ).pipe(Effect.provide(JobStoreLive)),
        );
        const outcome = await terminal(id);
        expect(outcome.status).toBe("ready");
        expect(outcome.logs.filter((log) => log.metadata.event === "retry")).toHaveLength(1);
        expect(
            outcome.logs.filter((log) => log.text === "Formatting Compose snapshot."),
        ).toHaveLength(2);
    });

    it("handles effect-mq timeouts through the failure hook and aborts the sidecar stream", async () => {
        mode = "hang";
        const id = await snapshot();
        await Effect.runPromise(
            DeployResource.enqueue({ deploymentId: id }, { attempts: 1, timeout: "1 second" }).pipe(
                Effect.provide(JobStoreLive),
            ),
        );
        expect(await terminal(id)).toMatchObject({
            status: "failed",
            error: 'effect-mq: job "DeployResource" timed out after 1000ms',
        });
        await closed.promise;
    }, 10_000);

    it("dispatches durable cancellation to DeployResource and never resurrects the row", async () => {
        mode = "hang";
        const id = await snapshot();
        await queueResourceDeployment(id);
        await received.promise;
        expect((await getDeploymentWithLogs(db, id))?.status).toBe("running");
        await cancelDeployment(other, id);
        await cancelDeploymentJob(id, "DeployResource");
        await closed.promise;
        await deployResource(other, id, new AbortController().signal);
        expect((await getDeploymentWithLogs(db, id))?.status).toBe("cancelled");
        expect(
            await db.query.resources.findFirst({ where: eq(resources.id, resourceId) }),
        ).toMatchObject({ spec: null, draftSpec: spec });
    }, 10_000);

    it("does not pick up cancelled deployments or issue requests after an early abort", async () => {
        const id = await snapshot();
        const count = requestCount;
        await expect(deployResource(db, id, AbortSignal.abort())).rejects.toThrow(
            RESOURCE_FAILURE_MESSAGE,
        );
        expect(await getDeploymentWithLogs(db, id)).toMatchObject({ status: "queued", logs: [] });
        await cancelDeployment(db, id);
        await deployResource(db, id, new AbortController().signal);
        expect(await getDeploymentWithLogs(db, id)).toMatchObject({
            status: "cancelled",
            logs: [],
        });
        expect(requestCount).toBe(count);
    });

    it.each(["release", "cancel", "timeout"] as const)(
        "waits for the cluster lock without retrying and drains the session on %s",
        async (outcome) => {
            mode = "hang";
            const first = await snapshot();
            const second = await snapshot();
            const abort = new AbortController();
            const running = deployResource(db, first, abort.signal);
            const rejected = expect(running).rejects.toThrow(RESOURCE_FAILURE_MESSAGE);

            try {
                await received.promise;
                const count = requestCount;
                await Effect.runPromise(
                    DeployResource.enqueue(
                        { deploymentId: second },
                        {
                            attempts: 1,
                            timeout: outcome === "timeout" ? "2 seconds" : "15 minutes",
                        },
                    ).pipe(Effect.provide(JobStoreLive)),
                );

                let waitingPid: number | undefined;
                // Inspect the native lock wait, never poll deployment logs.
                await expect
                    .poll(async () => {
                        const result = await db.$client.query<{ pid: number }>(
                            `SELECT pid FROM pg_stat_activity
                         WHERE datname = current_database() AND wait_event = 'advisory'`,
                        );

                        waitingPid = result.rows[0]?.pid;

                        return waitingPid;
                    })
                    .toBeDefined();
                expect(requestCount).toBe(count);
                expect((await getDeploymentWithLogs(db, second))?.status).toBe("queued");

                const job = await db.$client.query(
                    `SELECT state, attempts_made FROM effect_mq_jobs WHERE id = $1`,
                    [`DeployResource/${second}`],
                );

                expect(job.rows).toEqual([{ state: "active", attempts_made: 0 }]);

                if (outcome === "release") {
                    mode = "success";
                    abort.abort();
                    await rejected;
                    const result = await terminal(second);
                    expect(result.status).toBe("ready");
                    expect(result.logs.some((log) => log.metadata.event === "retry")).toBe(false);
                    expect(requestCount).toBe(count + 1);
                } else if (outcome === "cancel") {
                    await cancelDeployment(other, second);
                    await cancelDeploymentJob(second, "DeployResource");
                    expect((await terminal(second)).status).toBe("cancelled");
                } else {
                    expect((await terminal(second)).status).toBe("failed");
                }

                // Cross-process cancellation is delivered on the worker's 2-second heartbeat.
                await expect
                    .poll(
                        async () => {
                            const result = await db.$client.query(
                                `SELECT state FROM effect_mq_jobs WHERE id = $1`,
                                [`DeployResource/${second}`],
                            );

                            return result.rows[0]?.state;
                        },
                        { timeout: 5_000 },
                    )
                    .toBe(
                        { release: "completed", cancel: "cancelled", timeout: "failed" }[outcome],
                    );
                await expect
                    .poll(async () => {
                        const result = await db.$client.query(
                            `SELECT pid, state, wait_event FROM pg_stat_activity WHERE pid = $1`,
                            [waitingPid],
                        );

                        return result.rows;
                    })
                    .toEqual([]);

                if (outcome !== "release") expect(requestCount).toBe(count);
            } finally {
                if (await cancelDeployment(db, second))
                    await cancelDeploymentJob(second, "DeployResource");
                abort.abort();
                await rejected;
                await cancelDeployment(db, first);
            }
        },
        10_000,
    );

    it("does not send invalid private Compose input to the sidecar", async () => {
        const id = await snapshot();
        await db
            .update(resourceDeploymentInputs)
            .set({ spec: `services: [${secret}` })
            .where(eq(resourceDeploymentInputs.deploymentId, id));
        const count = requestCount;
        await Effect.runPromise(
            DeployResource.enqueue({ deploymentId: id }, { attempts: 1 }).pipe(
                Effect.provide(JobStoreLive),
            ),
        );
        expect((await terminal(id)).status).toBe("failed");
        expect(requestCount).toBe(count);
    });

    it("writes the monitoring failure log before its terminal status too", async () => {
        const id = randomUUID();
        const requestId = new Date().toISOString();
        await db.insert(deployments).values({
            id,
            clusterId,
            jobId: `${clusterId}:${requestId}`,
            name: "InitializeCluster",
        });
        await Effect.runPromise(
            InitializeCluster.enqueue(
                { clusterId, requestId },
                { attempts: 1, timeout: "1 millis" },
            ).pipe(Effect.provide(JobStoreLive)),
        );
        const outcome = await terminal(id);
        expect(outcome.status).toBe("failed");
        expect(outcome.logs.at(-1)?.metadata).toEqual({ level: "error", event: "failed" });
    });

    it("rejects immediate enqueue failures so the caller can leave recovery to the outbox", async () => {
        const url = process.env.DATABASE_URL!;
        vi.stubEnv("DATABASE_URL", "");

        try {
            await expect(queueResourceDeployment(randomUUID())).rejects.toThrow("DATABASE_URL");
        } finally {
            vi.stubEnv("DATABASE_URL", url);
        }
    });
});
