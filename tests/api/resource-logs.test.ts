import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import {
    clusterMonitoring,
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import type { LogEvent } from "@stoat/uncloud";
import { ALLOY_SERVICE, GREPTIME_SERVICE } from "@stoat/workflows/monitoring-compose";
import { encryptMonitoringPassword } from "@stoat/workflows/secrets";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
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
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import type { ResourceLog, ResourceLogEvent } from "../../packages/api/src/routers/resources/logs";

const exec = promisify(execFile);

const nativeFetch = globalThis.fetch;

const secret = "resource-log-test-secret-with-at-least-32-characters";

const password = "private-monitoring-password";

const start = "2026-01-01T00:00:00.000000000Z";

const end = "2026-01-02T00:00:00.000000000Z";

const time = "2026-01-01T12:00:00.123456789Z";

function sqlResponse(rows: unknown[][]) {
    return Response.json({
        exitCode: 0,
        stderr: "",
        truncated: false,
        stdout: JSON.stringify({ output: [{ records: { rows } }] }),
    });
}

function log(message = "hello", serviceId = "web-id"): LogEvent {
    return {
        timestamp: time,
        message,
        stream: "stdout",
        metadata: { serviceId, machineId: "machine", containerId: "container" },
    };
}

describe("resource logs backend", () => {
    const databaseName = `stoat_logs_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const resourceId = randomUUID();
    const input = { projectId, resourceId };
    const selection = { ...input, serviceIds: ["web-id"] };
    const search = { ...selection, start, end, query: "" };
    let db: ReturnType<typeof createDb>;
    let admin: ReturnType<typeof createDb>;
    let context: Context;
    let organizationId: string;
    let greptimeContainer = "";
    let greptimeUrl: string;
    let inspected: string[];
    let inspectionFailures: Set<string>;
    let queries: string[];
    let sqlHandler: (query: string, signal?: AbortSignal | null) => Promise<Response>;
    let streams: Map<string, ReadableStreamDefaultController<Uint8Array>>;
    let cancelled: Set<string>;
    let current: Map<string, string>;
    let replicas: Map<string, string[]>;
    let containerNames: Map<string, string>;
    let openedStreams: string[];
    let openStream: (id: string, signal?: AbortSignal | null) => Promise<Response>;

    async function executeSql(query: string) {
        const response = await nativeFetch(`${greptimeUrl}/v1/sql`, {
            method: "POST",
            body: new URLSearchParams({ sql: query }),
            signal: AbortSignal.timeout(15_000),
        });

        const result = await response.json();

        if (result.error) throw new Error(result.error);

        return result;
    }

    async function useGreptime() {
        await executeSql("DROP TABLE IF EXISTS monitoring.docker_logs");
        await executeSql(`CREATE TABLE monitoring.docker_logs (
            greptime_timestamp TIMESTAMP(9) TIME INDEX, customer_id STRING, uncloud_service_id STRING,
            machine_id STRING, container STRING, "line" STRING,
            PRIMARY KEY(customer_id, uncloud_service_id, machine_id, container))`);
        sqlHandler = async (query) =>
            Response.json({
                exitCode: 0,
                truncated: false,
                stderr: "",
                stdout: JSON.stringify(await executeSql(query)),
            });
    }

    async function deployment(
        status = "ready",
        spec = "services:\n  web:\n    image: nginx\n",
        prefix = "",
        attempted = false,
    ) {
        const id = randomUUID();
        await db
            .insert(deployments)
            .values({ id, clusterId, resourceId, jobId: id, name: "DeployResource", status });
        await db.insert(resourceDeploymentInputs).values({ deploymentId: id, spec, prefix });

        if (attempted)
            await db.$client.query(
                `INSERT INTO deployment_logs (deployment_id, text, metadata, created_at) VALUES ($1, 'Deploying Compose to the cluster.', '{"event":"step"}', now())`,
                [id],
            );

        return id;
    }

    async function enableHistory() {
        const monitoringProject = randomUUID();
        const monitoringResource = randomUUID();
        await db
            .insert(projects)
            .values({ id: monitoringProject, clusterId, name: "Monitoring", isInternal: true });
        await db
            .insert(resources)
            .values({ id: monitoringResource, projectId: monitoringProject, name: "Monitoring" });
        await db.insert(clusterMonitoring).values({
            clusterId,
            projectId: monitoringProject,
            resourceId: monitoringResource,
            machineId: "machine",
            encryptedPassword: encryptMonitoringPassword(password, secret, clusterId),
        });
        await db
            .update(clusters)
            .set({
                initializedAt: new Date(),
                initializationConfiguration: {
                    machineId: "machine",
                    retentionDays: 14,
                    alloyStorage: { type: "volume", source: "a" },
                    greptimeStorage: { type: "volume", source: "g" },
                },
            })
            .where(eq(clusters.id, clusterId));
    }

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('logger', 'Logger', 'logger@example.test')`,
        );

        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'logger'`,
        );

        organizationId = membership.rows[0].organization_id;
        // SAFETY: these are the real DB-backed session fields read by authorization.
        context = {
            db,
            session: {
                user: { id: "logger" },
                session: {
                    id: "log-session",
                    token: "log-token",
                    activeOrganizationId: organizationId,
                },
            },
        } as Context;
        greptimeContainer = (
            await exec("docker", [
                "run",
                "--rm",
                "-d",
                "-p",
                "127.0.0.1::4000",
                "greptime/greptimedb:v1.2.1",
                "standalone",
                "start",
                "--http-addr",
                "0.0.0.0:4000",
            ])
        ).stdout.trim();
        const address = (await exec("docker", ["port", greptimeContainer, "4000"])).stdout.trim();
        greptimeUrl = `http://${address}`;
        await vi.waitFor(
            async () => {
                expect((await nativeFetch(`${greptimeUrl}/health`)).ok).toBe(true);
            },
            { timeout: 20_000, interval: 100 },
        );
        await executeSql("CREATE DATABASE monitoring");
    }, 60_000);

    beforeEach(async () => {
        vi.stubEnv("BETTER_AUTH_SECRET", secret);
        await db.delete(clusters);
        await db.$client.query(`DELETE FROM session WHERE user_id = 'logger'`);
        await db.$client.query(`UPDATE "user" SET banned = false WHERE id = 'logger'`);
        await db.$client.query(
            `INSERT INTO member (id, organization_id, user_id, role, created_at)
            SELECT 'log-member', $1, 'logger', 'member', now() WHERE NOT EXISTS (SELECT 1 FROM member WHERE user_id = 'logger')`,
            [organizationId],
        );
        await db.$client.query(
            `INSERT INTO session (id, token, user_id, active_organization_id, expires_at, updated_at)
            VALUES ('log-session', 'log-token', 'logger', $1, now() + interval '1 hour', now())`,
            [organizationId],
        );
        await db.insert(clusters).values({
            id: clusterId,
            name: "Logs",
            organizationId,
            sidecarUrl: "http://sidecar.logs.test",
            sidecarToken: "sidecar-secret",
        });
        await db.insert(projects).values({ id: projectId, clusterId, name: "Project" });
        await db.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Resource",
            spec: "services:\n  editable-draft:\n    image: secret\n",
        });
        inspected = [];
        inspectionFailures = new Set();
        queries = [];
        streams = new Map();
        cancelled = new Set();
        current = new Map([
            ["web", "web-id"],
            ["worker", "worker-id"],
        ]);
        replicas = new Map();
        containerNames = new Map();
        openedStreams = [];
        sqlHandler = async (query) =>
            sqlResponse(
                query.includes("information_schema")
                    ? [
                          "greptime_timestamp",
                          "line",
                          "uncloud_service_id",
                          "customer_id",
                          "machine_id",
                          "container",
                      ].map((column) => [column])
                    : [],
            );
        openStream = async (id) =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        streams.set(id, controller);
                    },
                    cancel() {
                        cancelled.add(id);
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            );
        vi.stubGlobal(
            "fetch",
            vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
                const url = new URL(String(request));
                expect(url.origin).toBe("http://sidecar.logs.test");
                expect(new Headers(options?.headers).get("authorization")).toBe(
                    "Bearer sidecar-secret",
                );
                const id = decodeURIComponent(url.pathname.split("/")[4]!);

                if (url.pathname.endsWith("/logs")) {
                    expect(url.searchParams.get("follow")).toBe("true");
                    expect(url.searchParams.get("tail")).toBe("100");

                    openedStreams.push(id);

                    return openStream(id, options?.signal);
                }

                if (url.pathname.endsWith("/exec")) {
                    expect(id).toBe("greptime-id");
                    const body = JSON.parse(String(options?.body));
                    expect(body.stdin).toBe(`user = "stoat:${password}"\n`);
                    expect(body.command.at(-1)).toBe("http://127.0.0.1:4000/v1/sql?db=public");
                    expect(body.command).toContain("--max-time");

                    const query = body.command
                        .find((arg: string) => arg.startsWith("sql="))
                        .slice(4);

                    queries.push(query);

                    return sqlHandler(query, options?.signal);
                }

                inspected.push(id);

                if (inspectionFailures.has(id))
                    return Response.json({ error: "private inspection failure" }, { status: 503 });

                if (id === GREPTIME_SERVICE)
                    return Response.json({
                        id: "greptime-id",
                        name: GREPTIME_SERVICE,
                        containers: [{ container: { Id: "greptime-container" } }],
                    });
                const serviceId = current.get(id);

                return serviceId
                    ? Response.json({
                          id: serviceId,
                          name: id,
                          containers: (replicas.get(serviceId) ?? []).map((id) => ({
                              machineId: "machine",
                              container: { Id: id, Name: containerNames.get(id), Config: { Env: ["PRIVATE=secret"] }, State: { Running: true } },
                          })),
                          hookContainers: [],
                          mode: "replicated",
                      })
                    : Response.json({ error: "not found" }, { status: 404 });
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    afterAll(async () => {
        if (greptimeContainer) await exec("docker", ["stop", "-t", "1", greptimeContainer]);
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    function send(id: string, event: ReturnType<typeof log>) {
        streams.get(id)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    }

    async function openBoth() {
        await deployment(
            "ready",
            "services:\n  web: { image: nginx }\n  worker: { image: nginx }\n",
        );

        const stream = await call(
            resourcesRouter.streamLogs,
            { ...input, serviceIds: ["web-id", "worker-id"] },
            { context },
        );

        const statuses = [(await stream.next()).value, (await stream.next()).value];
        expect(statuses).toEqual(
            expect.arrayContaining([
                { type: "status", serviceId: "web-id", state: "connected" },
                { type: "status", serviceId: "worker-id", state: "connected" },
            ]),
        );

        return stream;
    }

    it("lists no nonexistent/queued services, then uses deployed snapshot prefixes and actual current IDs", async () => {
        expect(await call(resourcesRouter.listLogServices, input, { context })).toEqual({
            services: [],
            historyAvailable: false,
            retentionDays: null,
        });
        expect(inspected).toEqual([
            `${projectId.slice(0, 8)}-${resourceId.slice(0, 8)}-editable-draft`,
        ]);
        inspected.length = 0;
        await deployment("queued");
        expect((await call(resourcesRouter.listLogServices, input, { context })).services).toEqual(
            [],
        );
        expect(inspected).toEqual([]);
        await deployment("ready", "services:\n  web: { image: nginx }\n", "deployed-prefix");
        current.set("deployed-prefix-web", "current-recreated-id");
        expect(await call(resourcesRouter.listLogServices, input, { context })).toEqual({
            services: [{ id: "current-recreated-id", name: "deployed-prefix-web" }],
            historyAvailable: false,
            retentionDays: null,
        });
        expect(inspected).toEqual(["deployed-prefix-web"]);
        await enableHistory();
        const response = await call(resourcesRouter.listLogServices, input, { context });
        expect(response).toMatchObject({ historyAvailable: true, retentionDays: 14 });
        expect(JSON.stringify(response)).not.toMatch(/secret|password|sidecar|encrypted/u);
    });

    it("resolves imported resources without snapshots for discovery, live logs, and history", async () => {
        await db
            .update(resources)
            .set({
                spec: `services:\n  web: { image: nginx }\n  missing: { image: nginx }\n  ${GREPTIME_SERVICE}: { image: private }\n`,
                settings: { prefixNames: false },
            })
            .where(eq(resources.id, resourceId));
        expect((await call(resourcesRouter.listLogServices, input, { context })).services).toEqual([
            { id: "web-id", name: "web" },
        ]);
        expect(inspected).not.toContain(GREPTIME_SERVICE);

        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        try {
            expect((await stream.next()).value).toEqual({
                type: "status",
                serviceId: "web-id",
                state: "connected",
            });
            send("web-id", log("legacy log"));
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ message: "legacy log", serviceId: "web-id" }],
            });
        } finally {
            await stream.return(undefined);
        }

        await enableHistory();
        expect(await call(resourcesRouter.searchLogs, search, { context })).toEqual({
            logs: [],
            nextCursor: null,
        });
        expect(queries.at(-1)).toContain("uncloud_service_id IN ('web-id')");
        await expect(
            call(resourcesRouter.searchLogs, { ...search, serviceIds: ["worker-id"] }, { context }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("reports a missing deployment migration accurately across log procedures", async () => {
        await db.$client.query(
            "ALTER TABLE deployments RENAME COLUMN resource_id TO missing_resource_id",
        );

        try {
            const expected = {
                code: "PRECONDITION_FAILED",
                message: "Database schema is out of date. Run pnpm db:migrate on the server.",
            };

            await expect(
                call(resourcesRouter.listLogServices, input, { context }),
            ).rejects.toMatchObject(expected);
            await expect(
                call(resourcesRouter.searchLogs, search, { context }),
            ).rejects.toMatchObject(expected);
            const stream = await call(resourcesRouter.streamLogs, selection, { context });
            await expect(stream.next()).rejects.toMatchObject(expected);
            expect(inspected).toEqual([]);
        } finally {
            await db.$client.query(
                "ALTER TABLE deployments RENAME COLUMN missing_resource_id TO resource_id",
            );
        }
    });

    it("includes partial attempts but never draft or reserved monitoring services", async () => {
        await deployment("ready");
        await deployment(
            "failed",
            `services:\n  worker: { image: nginx }\n  ${GREPTIME_SERVICE}: { image: private }\n`,
            "",
            true,
        );
        expect((await call(resourcesRouter.listLogServices, input, { context })).services).toEqual([
            { id: "worker-id", name: "worker" },
            { id: "web-id", name: "web" },
        ]);
        expect(inspected).not.toContain(GREPTIME_SERVICE);
        await db.delete(deployments);
        await deployment("failed", undefined, "", true);
        expect((await call(resourcesRouter.listLogServices, input, { context })).services).toEqual([
            { id: "web-id", name: "web" },
        ]);
    });

    it("uses inspected container names without another startup request or exposing inspection secrets", async () => {
        await deployment();
        replicas.set("web-id", ["container"]);
        containerNames.set("container", "/web-db-actual-name");
        const list = await call(resourcesRouter.listLogServices, input, { context });
        expect(list.services).toEqual([{ id: "web-id", name: "web" }]);
        expect(JSON.stringify(list)).not.toMatch(/PRIVATE|secret|containers|Config/u);
        inspected.length = 0;
        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        try {
            expect((await stream.next()).value).toMatchObject({ state: "connected" });
            expect(inspected).toEqual(["web"]);
            send("web-id", log());
            expect((await stream.next()).value).toMatchObject({ logs: [{ container: "web-db-actual-name", serviceName: "web" }] });
            send("web-id", { ...log(), metadata: { serviceId: "web-id", machineId: "another-machine", containerId: "container" } });
            expect((await stream.next()).value).toMatchObject({ logs: [{ container: "container" }] });
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["disabled", "ready", "initializing", "missing monitoring", "missing retention"])(
        "discovers sanitized services and opens logs with one inspection per service, history %s",
        async (history) => {
            await deployment("ready", `services:
  web: { image: nginx }
  worker: { image: nginx }
  missing: { image: nginx }
  ${GREPTIME_SERVICE}: { image: private }
  ${ALLOY_SERVICE}: { image: private }
  stoat-monitoring-private: { image: private }
`);

            for (const name of [GREPTIME_SERVICE, ALLOY_SERVICE, "stoat-monitoring-private"])
                current.set(name, `${name}-id`);
            replicas.set("web-id", ["container"]);
            replicas.set("worker-id", ["worker-container"]);
            containerNames.set("container", "/web-actual-name");

            if (history !== "disabled") await enableHistory();

            if (history === "initializing")
                await db.update(clusters).set({ initializedAt: null }).where(eq(clusters.id, clusterId));

            if (history === "missing monitoring") await db.delete(clusterMonitoring);

            if (history === "missing retention")
                await db.update(clusters).set({ initializationConfiguration: null }).where(eq(clusters.id, clusterId));
            const stream = await call(resourcesRouter.streamLogs, input, { context });

            try {
                const metadata = (await stream.next()).value;
                expect(metadata).toEqual({
                    type: "services",
                    services: [{ id: "web-id", name: "web" }, { id: "worker-id", name: "worker" }],
                    historyAvailable: history === "ready" || history === "missing retention",
                    retentionDays: history === "ready" ? 14 : null,
                });
                expect(JSON.stringify(metadata)).not.toMatch(/PRIVATE|secret|password|sidecar|encrypted|containers|Config|Env/u);
                expect(openedStreams).toEqual([]);
                expect([(await stream.next()).value, (await stream.next()).value]).toEqual(
                    expect.arrayContaining([
                        { type: "status", serviceId: "web-id", state: "connected" },
                        { type: "status", serviceId: "worker-id", state: "connected" },
                    ]),
                );
                expect(inspected).toEqual(["web", "worker", "missing"]);
                send("web-id", log());
                expect((await stream.next()).value).toMatchObject({
                    type: "logs",
                    logs: [{ serviceId: "web-id", serviceName: "web", container: "web-actual-name" }],
                });
                const pending = stream.next();
                const returned = stream.return(undefined);
                expect(await pending).toEqual({ done: true, value: undefined });
                await returned;
                expect(cancelled).toEqual(new Set(["web-id", "worker-id"]));
                expect(queries).toEqual([]);
            } finally {
                await stream.return(undefined);
            }
        },
    );

    it("resolves selected names to the latest IDs at startup without opening other services", async () => {
        await deployment("ready", "services:\n  web: { image: nginx }\n  worker: { image: nginx }\n");
        expect((await call(resourcesRouter.listLogServices, input, { context })).services).toEqual([
            { id: "web-id", name: "web" }, { id: "worker-id", name: "worker" },
        ]);
        const stream = await call(resourcesRouter.streamLogs, { ...input, serviceNames: ["web"] }, { context });
        current.set("web", "recreated-id");
        inspected.length = 0;

        try {
            expect((await stream.next()).value).toEqual({
                type: "services",
                services: [{ id: "recreated-id", name: "web" }, { id: "worker-id", name: "worker" }],
                historyAvailable: false,
                retentionDays: null,
            });
            expect(openedStreams).toEqual([]);
            expect((await stream.next()).value).toEqual({ type: "status", serviceId: "recreated-id", state: "connected" });
            send("recreated-id", log("selected replacement", "recreated-id"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "recreated-id", serviceName: "web", message: "selected replacement" }] });
            expect(inspected).toEqual(["web", "worker"]);
            expect(openedStreams).toEqual(["recreated-id"]);
        } finally {
            await stream.return(undefined);
        }

        expect(cancelled).toEqual(new Set(["recreated-id"]));
    });

    it.each(["all", "one"])("opens no tails while %s selected names are missing, then resolves restored names on retry", async (missing) => {
        await deployment("ready", "services:\n  web: { image: nginx }\n  worker: { image: nginx }\n");
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

        if (missing === "all") current.clear();
        else current.delete("web");
        const selected = { ...input, serviceNames: ["web", "worker"] };
        const stream = await call(resourcesRouter.streamLogs, selected, { context });

        try {
            expect((await stream.next()).value).toEqual({
                type: "services",
                services: missing === "all" ? [] : [{ id: "worker-id", name: "worker" }],
                historyAvailable: false,
                retentionDays: null,
            });
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            expect(openedStreams).toEqual([]);
            expect(cancelled.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await stream.return(undefined);
        }

        current.set("web", "restored-id");
        current.set("worker", "worker-id");
        const retry = await call(resourcesRouter.streamLogs, selected, { context });

        try {
            expect((await retry.next()).value).toEqual({
                type: "services",
                services: [{ id: "restored-id", name: "web" }, { id: "worker-id", name: "worker" }],
                historyAvailable: false,
                retentionDays: null,
            });
            expect(openedStreams).toEqual([]);
            expect([(await retry.next()).value, (await retry.next()).value]).toEqual(expect.arrayContaining([
                { type: "status", serviceId: "restored-id", state: "connected" },
                { type: "status", serviceId: "worker-id", state: "connected" },
            ]));
            send("restored-id", log("restored selection", "restored-id"));
            expect((await retry.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "restored-id", message: "restored selection" }] });
            expect(openedStreams).toEqual(["restored-id", "worker-id"]);
        } finally {
            await retry.return(undefined);
        }

        expect(cancelled).toEqual(new Set(["restored-id", "worker-id"]));
        expect(vi.getTimerCount()).toBe(0);
    });

    it("includes all discovered identities in metadata but streams only the first 20 services", async () => {
        const names = Array.from({ length: 23 }, (_, index) => `service-${index}`);
        await deployment("ready", `services:\n${names.map((name) => `  ${name}: { image: nginx }`).join("\n")}\n`);

        for (const name of names) current.set(name, `${name}-id`);
        const stream = await call(resourcesRouter.streamLogs, input, { context });

        try {
            expect((await stream.next()).value).toEqual({
                type: "services",
                services: names.map((name) => ({ id: `${name}-id`, name })),
                historyAvailable: false,
                retentionDays: null,
            });
            const statuses: ResourceLogEvent[] = [];

            for (let i = 0; i < 20; i++) statuses.push((await stream.next()).value!);
            expect(statuses).toEqual(expect.arrayContaining(names.slice(0, 20).map((name) => ({
                type: "status", serviceId: `${name}-id`, state: "connected",
            }))));
            expect(inspected).toEqual(names);
            expect(openedStreams).toEqual(names.slice(0, 20).map((name) => `${name}-id`));
        } finally {
            await stream.return(undefined);
        }

        expect(cancelled).toEqual(new Set(names.slice(0, 20).map((name) => `${name}-id`)));
    });

    it.each(["queued", "ready"])("emits empty services and ends cleanly for %s deployments without current services", async (status) => {
        await deployment(status);
        current.clear();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await call(resourcesRouter.streamLogs, input, { context });

        try {
            expect((await stream.next()).value).toEqual({
                type: "services", services: [], historyAvailable: false, retentionDays: null,
            });
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            expect(inspected).toEqual(status === "ready" ? ["web"] : []);
            expect(openedStreams).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await stream.return(undefined);
        }
    });

    it("inspects services concurrently with an eight-request ceiling", async () => {
        const names = Array.from({ length: 17 }, (_, index) => `service-${index}`);
        await deployment("ready", `services:\n${names.map((name) => `  ${name}: { image: nginx }`).join("\n")}\n`);

        for (const name of names) current.set(name, `${name}-id`);
        const original = globalThis.fetch;
        let active = 0;
        let maximum = 0;
        vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
            active++;
            maximum = Math.max(maximum, active);

            try {
                await new Promise((resolve) => setTimeout(resolve, 10));

                return await original(...args);
            } finally {
                active--;
            }
        }));
        const result = await call(resourcesRouter.listLogServices, input, { context });
        expect(result.services.map((service) => service.name)).toEqual(names);
        expect(maximum).toBe(8);
    });

    it("reads only metadata for older deployment candidates and one current spec body", async () => {
        for (let i = 0; i < 4; i++) await deployment("ready", "#".repeat(1024 * 1024));
        await deployment();
        const reads = vi.spyOn(db, "select");
        expect((await call(resourcesRouter.listLogServices, input, { context })).services).toEqual([
            { id: "web-id", name: "web" },
        ]);
        const projections = reads.mock.calls.map(([fields]) => Object.keys(fields ?? {}));
        expect(projections).toContainEqual(["id", "status"]);
        expect(projections.filter((fields) => fields.includes("spec"))).toEqual([
            ["spec", "prefix"],
        ]);
    });

    it("rejects foreign org/project, internal and missing resources before contacting sidecar", async () => {
        await expect(
            call(
                resourcesRouter.listLogServices,
                { ...input, projectId: randomUUID() },
                { context },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
            call(
                resourcesRouter.listLogServices,
                { ...input, resourceId: randomUUID() },
                { context },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await db.update(projects).set({ isInternal: true }).where(eq(projects.id, projectId));
        await expect(
            call(resourcesRouter.listLogServices, input, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await db.update(projects).set({ isInternal: false }).where(eq(projects.id, projectId));
        const foreign = randomUUID();
        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Foreign', $1, now())`,
            [foreign],
        );
        await db
            .update(clusters)
            .set({ organizationId: foreign })
            .where(eq(clusters.id, clusterId));
        await expect(
            call(resourcesRouter.listLogServices, input, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(inspected).toEqual([]);
    });

    it.each([
        { serviceIds: [] },
        { serviceIds: ["web-id", "web-id"] },
        { serviceIds: ["bad'id"] },
        { serviceIds: Array.from({ length: 21 }, (_, i) => `id-${i}`) },
    ])("rejects invalid service selection %j", async ({ serviceIds }) => {
        for (const selected of [{ serviceIds }, { serviceNames: serviceIds }])
            await expect(
                call(resourcesRouter.streamLogs, { ...input, ...selected }, { context }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(
            call(resourcesRouter.searchLogs, { ...search, serviceIds }, { context }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(inspected).toEqual([]);
        expect(openedStreams).toEqual([]);
    });

    it("rejects mixed ID and name selection before contacting the sidecar", async () => {
        await expect(
            call(resourcesRouter.streamLogs, { ...selection, serviceNames: ["web"] }, { context }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(inspected).toEqual([]);
        expect(openedStreams).toEqual([]);
    });

    it.each(["worker", GREPTIME_SERVICE, ALLOY_SERVICE, "stoat-monitoring-private"])("opens no logs when selected name %s is outside the resource log scope", async (name) => {
        await deployment("ready", `services:\n  web: { image: nginx }\n  ${GREPTIME_SERVICE}: { image: private }\n  ${ALLOY_SERVICE}: { image: private }\n  stoat-monitoring-private: { image: private }\n`);
        current.set(name, "excluded-id");
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await call(resourcesRouter.streamLogs, { ...input, serviceNames: ["web", name] }, { context });

        try {
            expect((await stream.next()).value).toEqual({
                type: "services",
                services: [{ id: "web-id", name: "web" }],
                historyAvailable: false,
                retentionDays: null,
            });
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            expect(inspected).toEqual(["web"]);
            expect(openedStreams).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await stream.return(undefined);
        }
    });

    it("still requires a service selection for historical search", async () => {
        await expect(
            // @ts-expect-error Historical search must reject omitted serviceIds at runtime too.
            call(resourcesRouter.searchLogs, { ...input, start, end, query: "" }, { context }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(inspected).toEqual([]);
    });

    it.each(["old-deleted-id", GREPTIME_SERVICE, "worker-id"])(
        "rejects unknown/non-resource selection %s",
        async (id) => {
            await deployment();

            const stream = await call(
                resourcesRouter.streamLogs,
                { ...input, serviceIds: [id] },
                { context },
            );

            await expect(stream.next()).rejects.toMatchObject({ code: "BAD_REQUEST" });
            await expect(
                call(resourcesRouter.searchLogs, { ...search, serviceIds: [id] }, { context }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        },
    );

    it("multiplexes idle connected statuses and nanosecond logs without Greptime; return aborts pending reads", async () => {
        vi.stubEnv("BETTER_AUTH_SECRET", "");
        const stream = await openBoth();

        try {
            const waiting = stream.next();
            send("worker-id", log("worker line", "worker-id"));
            expect((await waiting).value).toEqual({
                type: "logs",
                logs: [
                    {
                        timestamp: time,
                        serviceId: "worker-id",
                        serviceName: "worker",
                        message: "worker line",
                        machine: "machine",
                        container: "container",
                        stream: "stdout",
                    },
                ],
            });
            send("web-id", log("web line"));
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ serviceId: "web-id", message: "web line" }],
            });
            const pending = stream.next();
            const returned = stream.return(undefined);
            expect(await pending).toEqual({ done: true, value: undefined });
            await returned;
            expect(cancelled).toEqual(new Set(["web-id", "worker-id"]));
            expect(queries).toEqual([]);
        } finally {
            await stream.return(undefined);
        }
    });

    it("aborts streams on request disconnect and does not mark a failed open connected", async () => {
        const original = openStream;
        openStream = async (id, signal) =>
            id === "web-id"
                ? Response.json({ error: "sidecar-secret private-password" }, { status: 500 })
                : original(id, signal);
        await deployment(
            "ready",
            "services:\n  web: { image: nginx }\n  worker: { image: nginx }\n",
        );
        const controller = new AbortController();

        const stream = await call(
            resourcesRouter.streamLogs,
            { ...input, serviceIds: ["web-id", "worker-id"] },
            { context, signal: controller.signal },
        );

        try {
            const events: ResourceLogEvent[] = [];

            for (let i = 0; i < 2; i++) events.push((await stream.next()).value!);
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "status",
                        serviceId: "web-id",
                        state: "reconnecting",
                    }),
                    { type: "status", serviceId: "worker-id", state: "connected" },
                ]),
            );
            expect(JSON.stringify(events)).not.toMatch(/sidecar-secret|private-password/u);
            send("worker-id", log("still healthy", "worker-id"));
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ message: "still healthy" }],
            });
            const pending = stream.next();
            controller.abort();
            expect((await pending).done).toBe(true);
            expect(cancelled.has("worker-id")).toBe(true);
        } finally {
            controller.abort();
            await stream.return(undefined);
        }
    });

    it.each([
        "membership",
        "session",
        "expiry",
        "token rotation",
        "resource",
        "internal",
        "banned",
        "active organization",
    ])(
        "revokes even idle live streams after %s changes",
        async (change) => {
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const stream = await openBoth();

            try {
                const pending = expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN" });

                if (change === "membership")
                    await db.$client.query(`DELETE FROM member WHERE user_id = 'logger'`);

                if (change === "session")
                    await db.$client.query(`DELETE FROM session WHERE id = 'log-session'`);

                if (change === "expiry")
                    await db.$client.query(
                        `UPDATE session SET expires_at = now() - interval '1 second' WHERE id = 'log-session'`,
                    );

                if (change === "token rotation")
                    await db.$client.query(
                        `UPDATE session SET token = 'rotated' WHERE id = 'log-session'`,
                    );

                if (change === "active organization")
                    await db.$client.query(
                        `UPDATE session SET active_organization_id = NULL WHERE id = 'log-session'`,
                    );

                if (change === "resource")
                    await db.delete(resources).where(eq(resources.id, resourceId));

                if (change === "internal")
                    await db
                        .update(projects)
                        .set({ isInternal: true })
                        .where(eq(projects.id, projectId));

                if (change === "banned")
                    await db.$client.query(`UPDATE "user" SET banned = true WHERE id = 'logger'`);
                await vi.advanceTimersByTimeAsync(15_000);
                await pending;
                expect(cancelled).toEqual(new Set(["web-id", "worker-id"]));
            } finally {
                await stream.return(undefined);
            }
        },
        20_000,
    );

    it.each(["before discovery", "after metadata", "live"])(
        "rejects automatic streams when membership is revoked %s",
        async (phase) => {
            await deployment();
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const stream = await call(resourcesRouter.streamLogs, input, { context });

            try {
                if (phase !== "before discovery")
                    expect((await stream.next()).value).toMatchObject({ type: "services" });

                if (phase === "live")
                    expect((await stream.next()).value).toEqual({ type: "status", serviceId: "web-id", state: "connected" });
                await db.$client.query(`DELETE FROM member WHERE user_id = 'logger'`);

                if (phase !== "before discovery") {
                    const transaction = vi.spyOn(db, "transaction");
                    await vi.advanceTimersByTimeAsync(15_000);
                    expect(transaction).toHaveBeenCalledTimes(1);
                    await expect(transaction.mock.results[0]!.value).rejects.toMatchObject({ code: "FORBIDDEN" });
                }

                await expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN" });
                expect(inspected).toEqual(phase === "before discovery" ? [] : ["web"]);
                expect(openedStreams).toEqual(phase === "live" ? ["web-id"] : []);
                expect(cancelled).toEqual(new Set(phase === "live" ? ["web-id"] : []));
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                await stream.return(undefined);
            }
        },
    );

    it.each(["revocation", "return", "disconnect"])(
        "stops automatic discovery on %s without emitting metadata or opening streams",
        async (stop) => {
            await deployment();
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const entered = Promise.withResolvers<void>();
            const original = globalThis.fetch;
            vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
                const response = await original(request, options);
                await new Promise<void>((resolve) => {
                    options!.signal!.addEventListener("abort", () => resolve(), { once: true });
                    entered.resolve();
                });

                return response;
            }));
            const controller = new AbortController();
            const stream = await call(resourcesRouter.streamLogs, input, { context, signal: controller.signal });

            try {
                const pending = stream.next().then((result) => result, (error) => error);
                await entered.promise;

                if (stop === "revocation") {
                    await db.$client.query(`DELETE FROM member WHERE user_id = 'logger'`);
                    await vi.advanceTimersByTimeAsync(15_000);
                } else if (stop === "return") await stream.return(undefined);
                else controller.abort();
                expect(await pending).toMatchObject(stop === "revocation"
                    ? { code: "FORBIDDEN" }
                    : { done: true, value: undefined });
                expect(inspected).toEqual(["web"]);
                expect(openedStreams).toEqual([]);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                controller.abort();
                await stream.return(undefined);
            }
        },
    );

    it("rejects oversized/misattributed live output per service without stopping healthy output", async () => {
        const stream = await openBoth();

        try {
            send("web-id", log("x".repeat(70_000)));
            expect((await stream.next()).value).toMatchObject({
                type: "status",
                serviceId: "web-id",
                state: "error",
            });
            send("worker-id", log("healthy", "worker-id"));
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ message: "healthy" }],
            });
            send("worker-id", log("wrong service", "another-id"));
            expect((await stream.next()).value).toMatchObject({
                type: "status",
                serviceId: "worker-id",
                state: "error",
            });
        } finally {
            await stream.return(undefined);
        }
    });

    it("revokes upstreams while the browser is paused, not only on the next read", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await openBoth();

        try {
            await db.$client.query(`DELETE FROM session WHERE id = 'log-session'`);
            await vi.advanceTimersByTimeAsync(15_000);
            await expect.poll(() => cancelled.size).toBe(2);
            await expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN" });
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["initial", "periodic"])(
        "bounds %s authorization even while pool acquisition is pending",
        async (phase) => {
            vi.useFakeTimers({
                toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
            });

            const stream =
                phase === "periodic"
                    ? await openBoth()
                    : await (async () => {
                          await deployment();

                          return call(resourcesRouter.streamLogs, selection, { context });
                      })();

            const waiting = Promise.withResolvers<void>();
            const entered = Promise.withResolvers<void>();
            const transaction = db.transaction.bind(db);

            const blocked = vi
                .spyOn(db, "transaction")
                .mockImplementation(async (callback, options) => {
                    entered.resolve();
                    await waiting.promise;

                    return transaction(callback, options);
                });

            try {
                const pending = expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN" });

                if (phase === "periodic") await vi.advanceTimersByTimeAsync(15_000);
                await entered.promise;
                await vi.advanceTimersByTimeAsync(5_000);
                await pending;
                expect(blocked).toHaveBeenCalledTimes(1);
                expect(cancelled.size).toBe(phase === "periodic" ? 2 : 0);
                // A late pool acquisition must not authorize/reopen anything or leak a rejection.
                const late = blocked.mock.results[0]!.value;
                const rejected = expect(late).rejects.toThrow();
                waiting.resolve();
                await rejected;
                expect((await stream.next()).done).toBe(true);
            } finally {
                waiting.resolve();
                await stream.return(undefined);
            }
        },
    );

    it("return cancels the initial authorization wait and removes its deadline", async () => {
        await deployment();
        const stream = await call(resourcesRouter.streamLogs, selection, { context });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const waiting = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        vi.spyOn(db, "transaction").mockImplementation(async () => {
            entered.resolve();
            await waiting.promise;
            throw new Error("late database failure");
        });

        try {
            const pending = stream.next();
            await entered.promise;
            const returned = stream.return(undefined);
            expect(await pending).toEqual({ done: true, value: undefined });
            await returned;
            expect(vi.getTimerCount()).toBe(0);
            waiting.resolve();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(openedStreams).toEqual([]);
        } finally {
            waiting.resolve();
            await stream.return(undefined);
        }
    });

    it("releases a real queued pool acquisition after the auth deadline without opening logs", async () => {
        await deployment();
        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        const connections = await Promise.all(
            Array.from({ length: db.$client.options.max ?? 10 }, () => db.$client.connect()),
        );

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            const pending = stream.next().then(
                () => null,
                (error) => error,
            );

            await vi.advanceTimersByTimeAsync(0);
            expect(db.$client.waitingCount).toBe(1);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await pending).toMatchObject({ code: "FORBIDDEN" });
            expect(openedStreams).toEqual([]);
        } finally {
            vi.useRealTimers();

            for (const connection of connections) connection.release();
            await stream.return(undefined);
        }

        await expect.poll(() => db.$client.waitingCount).toBe(0);
        await expect.poll(() => db.$client.idleCount).toBe(db.$client.totalCount);
    });

    it.each(["web", "all"])("recovers %s inspection failures without reconnecting healthy services", async (failed) => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await openBoth();
        const names = failed === "all" ? ["web", "worker"] : ["web"];

        try {
            for (const name of names) inspectionFailures.add(name);
            const pending = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            const events = [(await pending).value];

            for (let index = 1; index < names.length; index++) events.push((await stream.next()).value);
            expect(events).toEqual(expect.arrayContaining(names.map((name) => ({
                type: "status", serviceId: `${name}-id`, state: "reconnecting",
                message: "Service could not be inspected. Retrying automatically.",
            }))));
            expect(cancelled).toEqual(new Set(names.map((name) => `${name}-id`)));

            // A prolonged outage must neither end the subscription nor reopen unchecked tails.
            const retry = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await retry).value).toMatchObject({ type: "status", state: "reconnecting" });

            for (let index = 1; index < names.length; index++) await stream.next();
            expect(openedStreams).toHaveLength(2);
            inspectionFailures.clear();
            const recovered = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            const replay = [(await recovered).value];

            for (let index = 1; index < names.length * 2; index++) replay.push((await stream.next()).value);

            for (const name of names) {
                const serviceId = `${name}-id`;
                expect(replay.filter((event) => event && "serviceId" in event && event.serviceId === serviceId)).toEqual([
                    { type: "reset", serviceId },
                    { type: "status", serviceId, state: "connected" },
                ]);
                send(serviceId, log("recovered", serviceId));
                expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId, message: "recovered" }] });
            }

            expect(openedStreams.filter((id) => id === "worker-id")).toHaveLength(failed === "all" ? 2 : 1);
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["close", "read failure", "open failure"])("reopens after %s with unchanged replicas", async (failure) => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const original = openStream;
        let failing = failure === "open failure";
        openStream = async (id, signal) => failing && id === "web-id"
            ? Response.json({ error: "private failure" }, { status: 502 })
            : original(id, signal);
        await deployment("ready", "services:\n  web: { image: nginx }\n  worker: { image: nginx }\n");
        const stream = await call(resourcesRouter.streamLogs, { ...input, serviceIds: ["web-id", "worker-id"] }, { context });

        try {
            const initial = [(await stream.next()).value, (await stream.next()).value];

            if (failure === "open failure") {
                expect(initial).toContainEqual(expect.objectContaining({ type: "status", serviceId: "web-id", state: "reconnecting" }));
                failing = false;
            } else {
                if (failure === "close") streams.get("web-id")!.close();
                else streams.get("web-id")!.error(new Error("private socket failure"));
                expect((await stream.next()).value).toMatchObject({ type: "status", serviceId: "web-id", state: "reconnecting" });
            }

            const reset = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await reset).value).toEqual({ type: "reset", serviceId: "web-id" });
            expect((await stream.next()).value).toEqual({ type: "status", serviceId: "web-id", state: "connected" });
            send("web-id", log("resumed"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ message: "resumed" }] });
            expect(openedStreams.filter((id) => id === "web-id")).toHaveLength(2);
            expect(openedStreams.filter((id) => id === "worker-id")).toHaveLength(1);
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["recover", "invalid"])("handles %s inspections while reconnecting status is backpressured", async (result) => {
        await deployment();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        try {
            await stream.next();
            inspectionFailures.add("web");
            const interrupted = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await interrupted).value).toMatchObject({ state: "reconnecting" });
            inspectionFailures.clear();

            if (result === "invalid") {
                const original = globalThis.fetch;
                vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
                    await original(request, options);

                    return Response.json({ id: "web-id", name: "web", containers: "invalid" });
                }));
            }

            // Do not ask for another event until the next inspection has finished.
            await vi.advanceTimersByTimeAsync(15_000);
            await expect.poll(() => inspected.length).toBe(3);

            if (result === "invalid") {
                expect((await stream.next()).value).toMatchObject({ type: "status", serviceId: "web-id", state: "error" });
                expect((await stream.next()).done).toBe(true);
                expect(openedStreams).toEqual(["web-id"]);
            } else {
                expect((await stream.next()).value).toEqual({ type: "reset", serviceId: "web-id" });
                expect((await stream.next()).value).toEqual({ type: "status", serviceId: "web-id", state: "connected" });
                expect(openedStreams).toEqual(["web-id", "web-id"]);
            }
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["return", "disconnect", "revocation"])("cancels inspection retries on %s", async (stop) => {
        await deployment();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const controller = new AbortController();
        const stream = await call(resourcesRouter.streamLogs, selection, { context, signal: controller.signal });

        try {
            await stream.next();
            inspectionFailures.add("web");
            const interrupted = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await interrupted).value).toMatchObject({ state: "reconnecting" });
            const pending = stream.next().then((result) => result, (error) => error);
            inspectionFailures.clear();

            if (stop === "return") await stream.return(undefined);
            else if (stop === "disconnect") controller.abort();
            else await db.$client.query(`DELETE FROM session WHERE id = 'log-session'`);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(await pending).toMatchObject(stop === "revocation" ? { code: "FORBIDDEN" } : { done: true });
            expect(openedStreams).toEqual(["web-id"]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            controller.abort();
            await stream.return(undefined);
        }
    });

    it("restarts only changed replicas, emits reset before replay, and ignores inspection ordering", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        replicas.set("web-id", ["replica-1"]);
        const stream = await openBoth();

        try {
            const old = streams.get("web-id");
            const reset = stream.next();
            replicas.set("web-id", ["replica-1", "replica-2"]);
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await reset).value).toEqual({ type: "reset", serviceId: "web-id" });
            expect(cancelled).toEqual(new Set(["web-id"]));
            expect((await stream.next()).value).toEqual({
                type: "status",
                serviceId: "web-id",
                state: "connected",
            });
            expect(streams.get("web-id")).not.toBe(old);
            expect(openedStreams.filter((id) => id === "worker-id")).toHaveLength(1);
            send("web-id", {
                ...log("new replica"),
                metadata: { serviceId: "web-id", containerId: "replica-2" },
            });
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ message: "new replica", container: "replica-2" }],
            });
            replicas.set("web-id", ["replica-2", "replica-1"]);
            await vi.advanceTimersByTimeAsync(15_000);
            send("worker-id", log("uninterrupted", "worker-id"));
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ message: "uninterrupted" }],
            });
            expect(openedStreams.filter((id) => id === "web-id")).toHaveLength(2);
            // Also detect replacements when UC closes the old tail before the timer runs.
            streams.get("web-id")!.close();
            expect((await stream.next()).value).toMatchObject({
                type: "status",
                serviceId: "web-id",
                state: "reconnecting",
            });
            const replaced = stream.next();
            replicas.set("web-id", ["replica-3"]);
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await replaced).value).toEqual({ type: "reset", serviceId: "web-id" });
            expect((await stream.next()).value).toMatchObject({
                type: "status",
                state: "connected",
            });
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["empty", "populated"])("follows repeated authorized replacements with %s replicas and rejects old-ID logs", async (containers) => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

        for (const id of ["web-id", "recreated-id", "latest-id"])
            replicas.set(id, containers === "empty" ? [] : ["container"]);
        const stream = await openBoth();

        try {
            let previous = "web-id";

            for (const id of ["recreated-id", "latest-id"]) {
                const pending = stream.next();
                current.set("web", id);
                await vi.advanceTimersByTimeAsync(15_000);
                const reset = (await pending).value;
                expect(reset).toEqual({ type: "reset", serviceId: previous, replacement: { id, name: "web" } });
                expect(JSON.stringify(reset)).not.toMatch(/PRIVATE|secret|containers|Config|Env/u);
                expect(cancelled.has(previous)).toBe(true);
                expect(openedStreams).not.toContain(id);
                expect((await stream.next()).value).toEqual({ type: "status", serviceId: id, state: "connected" });
                send(id, log("replacement log", id));
                expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: id, serviceName: "web", message: "replacement log" }] });
                previous = id;
            }

            send("latest-id", log("stale attribution", "recreated-id"));
            expect((await stream.next()).value).toMatchObject({ type: "status", serviceId: "latest-id", state: "error" });
            send("worker-id", log("healthy", "worker-id"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "worker-id", message: "healthy" }] });
            inspected.length = 0;
            await vi.advanceTimersByTimeAsync(15_000);
            await expect.poll(() => inspected).toEqual(["worker"]);
            expect(openedStreams).toEqual(["web-id", "worker-id", "recreated-id", "latest-id"]);
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["deployment", "imported spec", "imported settings"])("denies replacement outside the fresh %s scope", async (scope) => {
        if (scope === "deployment") await deployment();
        else await db.update(resources).set({
            spec: "services:\n  web: { image: nginx }\n",
            settings: { prefixNames: false },
        }).where(eq(resources.id, resourceId));
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        try {
            expect((await stream.next()).value).toEqual({ type: "status", serviceId: "web-id", state: "connected" });

            if (scope === "deployment") await deployment("ready", "services:\n  worker: { image: nginx }\n");
            else if (scope === "imported spec")
                await db.update(resources).set({ spec: "services:\n  worker: { image: nginx }\n" }).where(eq(resources.id, resourceId));
            else {
                await db.update(resources).set({ settings: { prefixNames: true } }).where(eq(resources.id, resourceId));
                current.set(`${projectId.slice(0, 8)}-${resourceId.slice(0, 8)}-web`, "prefixed-id");
            }

            inspected.length = 0;
            const pending = stream.next();
            current.set("web", "recreated-id");
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await pending).value).toEqual({
                type: "status", serviceId: "web-id", state: "error",
                message: "Service is no longer in this resource or its inspection was invalid.",
            });
            expect((await stream.next()).done).toBe(true);
            expect(inspected).toEqual(["web", scope === "imported settings" ? `${projectId.slice(0, 8)}-${resourceId.slice(0, 8)}-web` : "worker"]);
            expect(openedStreams).toEqual(["web-id"]);
            expect(cancelled).toEqual(new Set(["web-id"]));
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await stream.return(undefined);
        }
    });

    it.each([503, 404])("retries a transient %i rediscovery failure without reopening an unchecked replacement", async (status) => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await openBoth();
        const original = globalThis.fetch;
        let inspections = 0;
        vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
            const response = await original(request, options);

            // The first web inspection detects the new ID; the second rechecks deployed scope.
            if (new URL(String(request)).pathname.endsWith("/services/web") && ++inspections === 2)
                return Response.json({ error: "private rediscovery failure" }, { status });

            return response;
        }));

        try {
            current.set("web", "recreated-id");
            const interrupted = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await interrupted).value).toEqual({
                type: "status", serviceId: "web-id", state: "reconnecting",
                message: "Service could not be inspected. Retrying automatically.",
            });
            expect(inspections).toBe(2);
            expect(openedStreams).toEqual(["web-id", "worker-id"]);
            expect(cancelled).toEqual(new Set(["web-id"]));
            send("worker-id", log("healthy", "worker-id"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "worker-id", message: "healthy" }] });
            const retry = stream.next();
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await retry).value).toEqual({ type: "reset", serviceId: "web-id", replacement: { id: "recreated-id", name: "web" } });
            expect((await stream.next()).value).toEqual({ type: "status", serviceId: "recreated-id", state: "connected" });
            send("recreated-id", log("recovered", "recreated-id"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "recreated-id", message: "recovered" }] });
            expect(inspections).toBe(4);
            expect(openedStreams).toEqual(["web-id", "worker-id", "recreated-id"]);
        } finally {
            await stream.return(undefined);
        }
    });

    it.each(["return", "disconnect", "revocation"])("stops on %s while rediscovery is delayed and ignores late success", async (stop) => {
        await deployment();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const controller = new AbortController();
        const stream = await call(resourcesRouter.streamLogs, selection, { context, signal: controller.signal });
        const entered = Promise.withResolvers<AbortSignal>();
        const waiting = Promise.withResolvers<void>();
        const original = globalThis.fetch;
        let inspections = 0;

        try {
            await stream.next();
            vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
                const response = await original(request, options);

                if (new URL(String(request)).pathname.endsWith("/services/web") && ++inspections === 2) {
                    entered.resolve(options!.signal!);
                    await waiting.promise;
                }

                return response;
            }));
            current.set("web", "recreated-id");
            const pending = stream.next().then((result) => result, (error) => error);
            await vi.advanceTimersByTimeAsync(15_000);
            const signal = await entered.promise;
            const transaction = vi.spyOn(db, "transaction");
            await vi.advanceTimersByTimeAsync(15_000);
            await expect.poll(() => transaction.mock.results.length).toBe(1);
            await transaction.mock.results[0]!.value;
            expect(inspections).toBe(2);
            expect(openedStreams).toEqual(["web-id"]);

            if (stop === "revocation") {
                await db.$client.query(`DELETE FROM session WHERE id = 'log-session'`);
                await vi.advanceTimersByTimeAsync(15_000);
            } else if (stop === "return") await stream.return(undefined);
            else controller.abort();
            expect(await pending).toMatchObject(stop === "revocation" ? { code: "FORBIDDEN" } : { done: true, value: undefined });
            expect(signal.aborted).toBe(true);
            expect(cancelled).toEqual(new Set(["web-id"]));
            expect(vi.getTimerCount()).toBe(0);
            waiting.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect((await stream.next()).done).toBe(true);
            expect(openedStreams).toEqual(["web-id"]);
        } finally {
            waiting.resolve();
            controller.abort();
            await stream.return(undefined);
        }
    });

    it("coalesces A-to-B-to-C replacement under backpressure into an old-to-latest reset", async () => {
        await deployment();
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        try {
            await stream.next();
            send("web-id", log("before replacement"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "web-id" }] });
            current.set("web", "recreated-id");
            await vi.advanceTimersByTimeAsync(15_000);
            await expect.poll(() => cancelled.has("web-id")).toBe(true);
            current.set("web", "latest-id");
            await vi.advanceTimersByTimeAsync(15_000);
            await expect.poll(() => inspected.length).toBe(5);
            await vi.advanceTimersByTimeAsync(0);
            expect(openedStreams).toEqual(["web-id"]);
            expect((await stream.next()).value).toEqual({ type: "reset", serviceId: "web-id", replacement: { id: "latest-id", name: "web" } });
            expect((await stream.next()).value).toEqual({ type: "status", serviceId: "latest-id", state: "connected" });
            send("latest-id", log("latest log", "latest-id"));
            expect((await stream.next()).value).toMatchObject({ type: "logs", logs: [{ serviceId: "latest-id", serviceName: "web", message: "latest log" }] });
            expect(openedStreams).toEqual(["web-id", "latest-id"]);
        } finally {
            await stream.return(undefined);
        }
    });

    it("bounds connection attempts and never reports a hung stream connected", async () => {
        await deployment();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const opening = Promise.withResolvers<void>();
        openStream = async (_id, signal) =>
            new Promise((_resolve, reject) => {
                signal!.addEventListener(
                    "abort",
                    () => reject(new Error("private upstream failure")),
                    { once: true },
                );
                opening.resolve();
            });
        const stream = await call(resourcesRouter.streamLogs, selection, { context });

        try {
            const next = stream.next();
            await opening.promise;
            await vi.advanceTimersByTimeAsync(15_000);
            expect((await next).value).toMatchObject({
                type: "status",
                serviceId: "web-id",
                state: "reconnecting",
            });
            const pending = stream.next();
            await stream.return(undefined);
            expect((await pending).done).toBe(true);
        } finally {
            await stream.return(undefined);
        }
    });

    it("isolates explicit upstream errors and ignores heartbeats", async () => {
        const stream = await openBoth();

        try {
            send("web-id", { ...log(), stream: "heartbeat" });
            send("web-id", { ...log(), error: "private-sidecar-secret" });
            const error = (await stream.next()).value;
            expect(error).toMatchObject({ type: "status", serviceId: "web-id", state: "reconnecting" });
            expect(JSON.stringify(error)).not.toContain("private-sidecar-secret");
            send("worker-id", log("healthy", "worker-id"));
            expect((await stream.next()).value).toMatchObject({
                type: "logs",
                logs: [{ message: "healthy" }],
            });
        } finally {
            await stream.return(undefined);
        }
    });

    it("requires monitoring only for history and validates fixed windows", async () => {
        await deployment();
        await expect(call(resourcesRouter.searchLogs, search, { context })).rejects.toMatchObject({
            code: "PRECONDITION_FAILED",
        });

        for (const invalid of [
            { start: end },
            { end: start },
            { start: "2024-01-01T00:00:00Z" },
            { start: "garbage" },
            { query: "\0" },
            { query: "x".repeat(4097) },
        ])
            await expect(
                call(resourcesRouter.searchLogs, { ...search, ...invalid }, { context }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("handles a missing table but surfaces database, malformed, truncated and oversized responses", async () => {
        await deployment();
        await enableHistory();
        sqlHandler = async () => sqlResponse([]);
        expect(await call(resourcesRouter.searchLogs, search, { context })).toEqual({
            logs: [],
            nextCursor: null,
        });

        for (const response of [
            {
                exitCode: 0,
                truncated: false,
                stdout: JSON.stringify({ code: 5000, error: "private-monitoring-password" }),
            },
            { exitCode: 22, truncated: false, stdout: "private-monitoring-password" },
            { exitCode: 0, truncated: true, stdout: "truncated" },
            { exitCode: 0, truncated: false, stdout: "malformed" },
            { exitCode: 0, truncated: false, stdout: "x".repeat(1024 * 1024) },
        ]) {
            sqlHandler = async () => Response.json(response);
            await expect(
                call(resourcesRouter.searchLogs, search, { context }),
            ).rejects.toMatchObject({
                code: "BAD_GATEWAY",
                message: expect.not.stringContaining(password),
            });
        }

        const original = sqlHandler;
        sqlHandler = async (query) =>
            query.includes("information_schema")
                ? sqlResponse(
                      [
                          "greptime_timestamp",
                          "line",
                          "uncloud_service_id",
                          "customer_id",
                          "machine_id",
                          "container",
                      ].map((name) => [name]),
                  )
                : sqlResponse([[time, "web-id", "x".repeat(32 * 1024 + 1), null, null, null]]);
        await expect(call(resourcesRouter.searchLogs, search, { context })).rejects.toMatchObject({
            code: "BAD_GATEWAY",
        });
        sqlHandler = original;
    });

    it("cancels a pending SQL response body on disconnect", async () => {
        await deployment();
        await enableHistory();
        let bodyCancelled = false;
        const opened = Promise.withResolvers<void>();
        sqlHandler = async () =>
            new Response(
                new ReadableStream({
                    start() {
                        opened.resolve();
                    },
                    cancel() {
                        bodyCancelled = true;
                    },
                }),
                { headers: { "content-type": "application/json" } },
            );
        const controller = new AbortController();

        const result = expect(
            call(resourcesRouter.searchLogs, search, { context, signal: controller.signal }),
        ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

        await opened.promise;
        controller.abort();
        await result;
        expect(bodyCancelled).toBe(true);
    });

    it("bounds the entire historical request, including a stalled exec body", async () => {
        await deployment();
        await enableHistory();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const deadlines: number[] = [];
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
            deadlines.push(ms);
            const controller = new AbortController();
            setTimeout(() => controller.abort(), ms);

            return controller.signal;
        });
        let bodyCancelled = false;
        const opened = Promise.withResolvers<void>();
        sqlHandler = async () =>
            new Response(
                new ReadableStream({
                    start() {
                        opened.resolve();
                    },
                    cancel() {
                        bodyCancelled = true;
                    },
                }),
                { headers: { "content-type": "application/json" } },
            );

        const result = expect(
            call(resourcesRouter.searchLogs, search, { context }),
        ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

        await opened.promise;
        await vi.advanceTimersByTimeAsync(30_000);
        await result;
        expect(deadlines).toContain(30_000);
        expect(bodyCancelled).toBe(true);
    });

    it("executes real Greptime SQL: >200 equal timestamps, nanos, literal matching, current IDs and scoped cursors", async () => {
        await deployment();
        await enableHistory();
        await useGreptime();
        const text = "MiXeD ' quote % _ \\ literal";
        const escape = (value: string) => `'${value.replaceAll("'", "''")}'`;

        const values = Array.from(
            { length: 405 },
            (_, i) =>
                `(${escape(time)}, ${escape(clusterId)}, 'web-id', 'machine', 'container-${String(i).padStart(3, "0")}', ${escape(text)})`,
        );

        values.push(`('${end}', '${clusterId}', 'web-id', 'machine', 'exclusive-end', 'exclude')`);
        values.push(`('${time}', '${clusterId}', 'old-id', 'machine', 'old', 'exclude')`);
        values.push(`('${time}', 'foreign-cluster', 'web-id', 'machine', 'foreign', 'exclude')`);
        await executeSql(`INSERT INTO monitoring.docker_logs VALUES ${values.join(",")}`);

        const first = await call(resourcesRouter.searchLogs, search, { context });
        expect(first.logs).toHaveLength(200);
        expect(first.logs[0]).toMatchObject({
            timestamp: time,
            stream: null,
            serviceId: "web-id",
            message: text,
        });
        expect(first.nextCursor).toEqual(expect.any(String));

        const second = await call(
            resourcesRouter.searchLogs,
            { ...search, cursor: first.nextCursor! },
            { context },
        );

        expect(second.logs).toHaveLength(200);

        const third = await call(
            resourcesRouter.searchLogs,
            { ...search, cursor: second.nextCursor! },
            { context },
        );

        expect(third.logs).toHaveLength(5);
        expect(third.nextCursor).toBeNull();
        expect(
            new Set([...first.logs, ...second.logs, ...third.logs].map((log) => log.container))
                .size,
        ).toBe(405);
        expect(queries.some((query) => query.includes("OFFSET 400"))).toBe(true);

        for (const query of [text.toLowerCase(), "% _ \\ literal"]) {
            expect(
                (await call(resourcesRouter.searchLogs, { ...search, query }, { context })).logs,
            ).toHaveLength(200);
        }

        for (const query of ["' OR 1=1 --", "\\' OR 1=1 --"])
            expect(
                (await call(resourcesRouter.searchLogs, { ...search, query }, { context })).logs,
            ).toEqual([]);
        expect(
            (
                await call(
                    resourcesRouter.searchLogs,
                    { ...search, start: "2026-01-01T12:00:00.123456790Z" },
                    { context },
                )
            ).logs,
        ).toEqual([]);

        const payload = first.nextCursor!.split(".")[0]!;

        const ascendingSignature = createHmac("sha256", password)
            .update(`stoat/log-cursor/v1:${payload}`)
            .digest("base64url");

        for (const changed of [
            { query: "other" },
            { end: time },
            { cursor: `${first.nextCursor}x` },
            { cursor: `${payload}.${ascendingSignature}` },
        ])
            await expect(
                call(
                    resourcesRouter.searchLogs,
                    { ...search, cursor: first.nextCursor!, ...changed },
                    { context },
                ),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        current.set("web", "recreated-id");
        await expect(
            call(resourcesRouter.searchLogs, { ...search, cursor: first.nextCursor! }, { context }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(
            (
                await call(
                    resourcesRouter.searchLogs,
                    { ...search, serviceIds: ["recreated-id"] },
                    { context },
                )
            ).logs,
        ).toEqual([]);
        await executeSql("ALTER TABLE monitoring.docker_logs ADD COLUMN stream STRING");
        current.set("web", "web-id");
        expect(
            (await call(resourcesRouter.searchLogs, search, { context })).logs[0]?.stream,
        ).toBeNull();
    });

    it.each([1, 8 * 1024])(
        "loads newest results across a 24h window, then walks older with %i-byte rows",
        async (bytes) => {
            await deployment();
            await enableHistory();
            await useGreptime();

            const groups = [
                { timestamp: "2026-01-01T23:59:59.999999999Z", count: 230 },
                { timestamp: "2026-01-01T23:59:59.999999998Z", count: 190 },
                { timestamp: start, count: 10 },
            ];

            const expected = groups.flatMap(({ timestamp, count }) =>
                Array.from({ length: count }, (_, i) => ({
                    timestamp,
                    container: `container-${String(i).padStart(3, "0")}`,
                })),
            );

            const values = expected
                .map(
                    ({ timestamp, container }) =>
                        `('${timestamp}', '${clusterId}', 'web-id', 'machine', '${container}', '${"x".repeat(bytes)}')`,
                )
                .reverse();

            values.push(
                `('${end}', '${clusterId}', 'web-id', 'machine', 'excluded-end', 'exclude')`,
            );
            values.push(
                `('2025-12-31T23:59:59.999999999Z', '${clusterId}', 'web-id', 'machine', 'excluded-start', 'exclude')`,
            );
            await executeSql(`INSERT INTO monitoring.docker_logs VALUES ${values.join(",")}`);
            const seen: { timestamp: string; container: string | null }[] = [];
            const sizes: number[] = [];
            let cursor: string | null = null;

            do {
                const page: { logs: ResourceLog[]; nextCursor: string | null } = await call(
                    resourcesRouter.searchLogs,
                    { ...search, cursor: cursor ?? undefined },
                    { context },
                );

                expect(page.logs.length).toBeGreaterThan(0);
                sizes.push(page.logs.length);
                seen.push(
                    ...page.logs.map(({ timestamp, container }) => ({ timestamp, container })),
                );
                cursor = page.nextCursor;

                if (cursor) {
                    const boundary = JSON.parse(
                        Buffer.from(cursor.split(".")[0]!, "base64url").toString(),
                    );

                    expect(boundary.timestamp).toBe(seen.at(-1)!.timestamp);
                    expect(boundary.offset).toBe(
                        seen.filter((row) => row.timestamp === boundary.timestamp).length,
                    );
                }
            } while (cursor && sizes.length < 10);

            expect(cursor).toBeNull();
            expect(seen).toEqual(expected);
            expect(sizes).toEqual(bytes === 1 ? [200, 200, 30] : [100, 100, 100, 100, 30]);
            expect(
                queries.some((query) => query.includes("ORDER BY greptime_timestamp DESC")),
            ).toBe(true);
        },
    );

    it.each([
        { bytes: 8 * 1024, count: 230, character: "x" },
        { bytes: 32 * 1024, count: 9, character: "\u0001" },
    ])(
        "adaptively paginates equal timestamps with $bytes-byte messages without dropping rows",
        async ({ bytes, count, character }) => {
            await deployment();
            await enableHistory();
            await useGreptime();
            const message = character.repeat(bytes);

            const values = Array.from(
                { length: count },
                (_, i) =>
                    `('${time}', '${clusterId}', 'web-id', 'machine', 'container-${String(i).padStart(3, "0")}', '${message}')`,
            );

            await executeSql(`INSERT INTO monitoring.docker_logs VALUES ${values.join(",")}`);
            const seen: string[] = [];
            let cursor: string | null = null;
            let pages = 0;

            do {
                const result: { logs: ResourceLog[]; nextCursor: string | null } = await call(
                    resourcesRouter.searchLogs,
                    { ...search, cursor: cursor ?? undefined },
                    { context },
                );

                expect(result.logs.length).toBeGreaterThan(0);
                expect(result.logs.length).toBeLessThan(200);

                for (const row of result.logs) {
                    expect(row.timestamp).toBe(time);
                    expect(row.message).toBe(message);
                    seen.push(row.container!);
                }

                cursor = result.nextCursor;

                if (cursor) {
                    const boundary = JSON.parse(
                        Buffer.from(cursor.split(".")[0]!, "base64url").toString(),
                    );

                    expect(boundary.offset).toBe(seen.length);
                }

                pages++;
            } while (cursor && pages < count);

            expect(cursor).toBeNull();
            expect(pages).toBeGreaterThan(1);
            expect(seen).toHaveLength(count);
            expect(new Set(seen).size).toBe(count);
            expect(queries.some((query) => query.includes("LIMIT 201"))).toBe(true);
            expect(queries.some((query) => query.includes("LIMIT 101"))).toBe(true);
        },
    );

    it("retries only explicit size overflows, with a finite two-row minimum", async () => {
        await deployment();
        await enableHistory();
        const schema = sqlHandler;
        sqlHandler = async (query) =>
            query.includes("information_schema")
                ? schema(query)
                : Response.json({
                      exitCode: 0,
                      truncated: false,
                      stdout: JSON.stringify({ code: 5000, error: "DB failure" }),
                  });
        await expect(call(resourcesRouter.searchLogs, search, { context })).rejects.toMatchObject({
            code: "BAD_GATEWAY",
        });
        expect(queries.filter((query) => query.includes("LIMIT"))).toHaveLength(1);
        queries = [];
        sqlHandler = async (query) =>
            query.includes("information_schema")
                ? schema(query)
                : Response.json({
                      exitCode: 0,
                      truncated: true,
                      stdout: "oversized",
                  });
        await expect(call(resourcesRouter.searchLogs, search, { context })).rejects.toMatchObject({
            code: "BAD_GATEWAY",
        });
        expect(queries.flatMap((query) => /LIMIT (\d+)/u.exec(query)?.slice(1) ?? [])).toEqual([
            "201",
            "101",
            "51",
            "26",
            "13",
            "7",
            "4",
            "2",
        ]);
    });

    it("documents fixed-window OFFSET semantics: late inserts require restarting the search", async () => {
        await deployment();
        await enableHistory();
        await useGreptime();

        const values = Array.from(
            { length: 201 },
            (_, i) =>
                `('${time}', '${clusterId}', 'web-id', 'machine', 'container-${String(i).padStart(3, "0")}', 'line')`,
        );

        await executeSql(`INSERT INTO monitoring.docker_logs VALUES ${values.join(",")}`);
        const first = await call(resourcesRouter.searchLogs, search, { context });
        await executeSql(
            `INSERT INTO monitoring.docker_logs VALUES ('${time}', '${clusterId}', 'web-id', 'machine', 'container--late', 'late arrival')`,
        );

        const next = await call(
            resourcesRouter.searchLogs,
            { ...search, cursor: first.nextCursor! },
            { context },
        );

        // No ingestion ID/snapshot exists: insertion before the boundary shifts its ordinal.
        expect(first.logs.at(-1)?.container).toBe("container-199");
        expect(next.logs.map((row) => row.container)).toEqual(["container-199", "container-200"]);
        expect(next.nextCursor).toBeNull();
        const restarted = await call(resourcesRouter.searchLogs, search, { context });
        expect(restarted.logs[0]?.container).toBe("container--late");
    });
});
