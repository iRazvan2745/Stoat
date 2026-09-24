import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call, createRouterClient } from "@orpc/server";
import { createDb } from "@stoat/db";
import {
    clusters,
    deployments,
    gitConnections,
    projects,
    resources,
    resourceDeploymentInputs,
} from "@stoat/db/schema/index";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
import { projectsRouter } from "../../packages/api/src/routers/projects";
import { resourcesRouter } from "../../packages/api/src/routers/resources";

describe("core project and resource isolation (PostgreSQL)", () => {
    const databaseName = `stoat_core_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const otherClusterId = randomUUID();
    const foreignClusterId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const foreignProjectId = randomUUID();
    const internalProjectId = randomUUID();
    const legacyProjectId = randomUUID();
    const resourceId = randomUUID();
    const foreignResourceId = randomUUID();
    const internalResourceId = randomUUID();
    const gitConnectionId = randomUUID();
    const spec = "services:\n  web:\n    image: nginx:alpine\n";
    const draftSpec = "services:\n  draft:\n    image: busybox\n";
    const settings = { env: "ORIGINAL=1\n", prefixNames: true, custom: { keep: [1, 2] } };

    const gitSource = {
        repositoryUrl: "https://git.example.test/team/app.git",
        branch: "main",
        path: "compose.yaml",
        revision: "a".repeat(40),
    };

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    const client = createRouterClient(resourcesRouter, { context: () => context });
    const fetch = vi.fn<typeof globalThis.fetch>();

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES
                ('core-member', 'Core Member', 'core@example.test'),
                ('foreign-owner', 'Foreign Owner', 'foreign@example.test')`,
        );

        const memberships = await db.$client.query<{ user_id: string; organization_id: string }>(
            `SELECT user_id, organization_id FROM member ORDER BY user_id`,
        );

        const organizationId = memberships.rows[0]!.organization_id;
        const foreignOrganizationId = memberships.rows[1]!.organization_id;
        await db.$client.query(`UPDATE member SET role = 'member' WHERE user_id = 'core-member'`);
        // SAFETY: these procedures read only identity and active organization from the session.
        context = {
            db,
            session: {
                user: { id: "core-member" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
        await db.insert(clusters).values([
            {
                id: clusterId,
                name: "Owned",
                organizationId,
                sidecarUrl: "http://owned.test",
                sidecarToken: "owned-token",
            },
            {
                id: otherClusterId,
                name: "Other",
                organizationId,
                sidecarUrl: "http://other.test",
                sidecarToken: "other-token",
            },
            {
                id: foreignClusterId,
                name: "Foreign",
                organizationId: foreignOrganizationId,
                sidecarUrl: "http://foreign.test",
                sidecarToken: "foreign-token",
            },
        ]);
        await db.insert(projects).values([
            { id: projectId, clusterId, name: "Owned", createdAt: new Date("2020-01-01") },
            {
                id: otherProjectId,
                clusterId: otherClusterId,
                name: "Other",
                createdAt: new Date("2020-01-02"),
            },
            {
                id: legacyProjectId,
                clusterId,
                name: "Legacy",
                isInternal: null,
                createdAt: new Date("2020-01-03"),
            },
            { id: foreignProjectId, clusterId: foreignClusterId, name: "Foreign" },
            { id: internalProjectId, clusterId, name: "Internal", isInternal: true },
        ]);
        await db.insert(gitConnections).values({
            id: gitConnectionId,
            name: "Source",
            organizationId,
            provider: "generic",
            serverUrl: "https://git.example.test",
        });
        await db.insert(resources).values([
            { id: resourceId, projectId, name: "Owned", spec, settings },
            { id: foreignResourceId, projectId: foreignProjectId, name: "Foreign", spec, settings },
            {
                id: internalResourceId,
                projectId: internalProjectId,
                name: "Internal",
                spec,
                settings,
            },
        ]);
    }, 30_000);

    beforeEach(() => {
        fetch.mockReset().mockRejectedValue(new Error("Unexpected external HTTP request"));
        vi.stubGlobal("fetch", fetch);
    });

    afterEach(() => vi.unstubAllGlobals());

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    async function resource(overrides: Partial<typeof resources.$inferInsert> = {}) {
        const [row] = await db
            .insert(resources)
            .values({
                id: randomUUID(),
                projectId,
                name: "Original",
                description: "Original description",
                icon: "original-icon",
                spec,
                draftSpec,
                settings,
                gitConnectionId,
                gitSource,
                createdAt: new Date("2021-01-01"),
                updatedAt: new Date("2021-01-01"),
                ...overrides,
            })
            .returning();

        return row!;
    }

    async function storedResource(id: string) {
        const [row] = await db.select().from(resources).where(eq(resources.id, id));

        return row!;
    }

    it("lists only public projects in the active organization, including legacy null flags and zero counts", async () => {
        const listed = await call(projectsRouter.listProjects, undefined, { context });
        expect(listed.map((row) => row.id)).toEqual([projectId, otherProjectId, legacyProjectId]);
        expect(listed.map((row) => row.resourceCount)).toEqual([1, 0, 0]);
        expect(listed.map((row) => row.clusterId)).toEqual([clusterId, otherClusterId, clusterId]);

        for (const row of listed) {
            expect(row).not.toHaveProperty("sidecarToken");
            expect(row).not.toHaveProperty("isInternal");
        }
    });

    it.each([
        {
            name: "  New project  ",
            description: "  Description  ",
            expectedName: "New project",
            expectedDescription: "Description",
        },
        {
            name: "x".repeat(100),
            description: " ",
            expectedName: "x".repeat(100),
            expectedDescription: null,
        },
        {
            name: "No description",
            description: undefined,
            expectedName: "No description",
            expectedDescription: null,
        },
    ])(
        "creates and persists a member's project: $expectedName",
        async ({ name, description, expectedName, expectedDescription }) => {
            const created = await call(
                projectsRouter.createProject,
                { clusterId, name, description },
                { context },
            );

            expect(created).toMatchObject({
                name: expectedName,
                description: expectedDescription,
                clusterId,
                resourceCount: 0,
            });
            expect(created.id).toEqual(expect.any(String));

            const [persisted] = await db
                .select()
                .from(projects)
                .where(eq(projects.id, created.id!));

            expect(persisted).toMatchObject({
                id: created.id,
                name: expectedName,
                description: expectedDescription,
                clusterId,
                isInternal: false,
            });
            const listed = await call(projectsRouter.listProjects, undefined, { context });
            expect(listed.find((row) => row.id === created.id)).toEqual(created);
        },
    );

    it.each(["", " \t\n ", "x".repeat(101)])(
        "rejects invalid project name %j without inserting",
        async (name) => {
            const before = await db.select().from(projects).orderBy(asc(projects.id));
            await expect(
                call(projectsRouter.createProject, { clusterId, name }, { context }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(await db.select().from(projects).orderBy(asc(projects.id))).toEqual(before);
        },
    );

    it("rejects an oversized project description without inserting", async () => {
        const before = await db.select().from(projects).orderBy(asc(projects.id));
        await expect(
            call(
                projectsRouter.createProject,
                { clusterId, name: "Valid", description: "x".repeat(501) },
                { context },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await db.select().from(projects).orderBy(asc(projects.id))).toEqual(before);
    });

    it.each([
        ["foreign", foreignClusterId],
        ["missing", randomUUID()],
    ])("cannot create a project in a %s cluster", async (_label, deniedClusterId) => {
        const before = await db.select().from(projects).orderBy(asc(projects.id));
        await expect(
            call(
                projectsRouter.createProject,
                { clusterId: deniedClusterId, name: "Injected" },
                { context },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await db.select().from(projects).orderBy(asc(projects.id))).toEqual(before);
    });

    it("reads full owned resources but lists only summaries for the requested project in creation order", async () => {
        const first = await resource({
            projectId: otherProjectId,
            createdAt: new Date("2020-01-01"),
        });

        const second = await resource({
            projectId: otherProjectId,
            createdAt: new Date("2020-01-02"),
        });

        expect(
            await client.getResource({ projectId: otherProjectId, resourceId: first.id }),
        ).toEqual(first);
        const listed = await client.listResources({ projectId: otherProjectId });
        expect(listed).toEqual(
            [first, second].map(
                ({ id, name, description, icon, type, projectId, createdAt, updatedAt }) => ({
                    id,
                    name,
                    description,
                    icon,
                    type,
                    projectId,
                    createdAt,
                    updatedAt,
                }),
            ),
        );

        const project = (await call(projectsRouter.listProjects, undefined, { context })).find(
            (row) => row.id === otherProjectId,
        );

        expect(project?.resourceCount).toBe(2);
        expect(await client.listResources({ projectId: legacyProjectId })).toEqual([]);
    });

    it("allows resource access in a legacy project with a null internal flag", async () => {
        const row = await resource({ projectId: legacyProjectId });
        expect(
            await client.getResource({ projectId: legacyProjectId, resourceId: row.id }),
        ).toEqual(row);
        expect(await client.listResources({ projectId: legacyProjectId })).toMatchObject([
            { id: row.id },
        ]);
    });

    it("creates a resource with trimmed details and no external IO", async () => {
        const created = await client.createResource({
            projectId,
            name: "  Compose  ",
            description: "  Description  ",
        });

        expect(created).toMatchObject({
            projectId,
            name: "Compose",
            description: "Description",
            type: "compose",
            spec: null,
            draftSpec: null,
            settings: null,
        });
        expect(await storedResource(created!.id)).toEqual(created);
        expect(fetch).not.toHaveBeenCalled();
    });

    describe.each([
        {
            label: "foreign organization",
            projectId: foreignProjectId,
            resourceId: foreignResourceId,
        },
        {
            label: "mismatched same-organization project",
            clusterId: otherClusterId,
            projectId: otherProjectId,
            resourceId,
        },
        {
            label: "foreign resource under an owned project",
            projectId,
            resourceId: foreignResourceId,
        },
        { label: "missing project", projectId: randomUUID(), resourceId },
        { label: "missing resource", projectId, resourceId: randomUUID() },
        { label: "internal project", projectId: internalProjectId, resourceId: internalResourceId },
    ])("$label", (input) => {
        it.each([
            "getResource",
            "getFormattedCompose",
            "getContainers",
            "updateSettings",
            "updateVariables",
            "updateDetails",
        ] as const)("denies %s without writes or external IO", async (operation) => {
            const before = await db.select().from(resources).orderBy(asc(resources.id));
            await expect(
                client[operation]({
                    clusterId,
                    ...input,
                    prefixNames: false,
                    env: "INJECTED=1",
                    name: "Injected",
                    description: "Injected",
                    icon: "injected-icon",
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await db.select().from(resources).orderBy(asc(resources.id))).toEqual(before);
            expect(fetch).not.toHaveBeenCalled();
        });
    });

    describe.each([
        ["foreign", foreignProjectId],
        ["internal", internalProjectId],
        ["missing", randomUUID()],
    ])("%s project", (_label, deniedProjectId) => {
        it.each(["listResources", "createResource"] as const)(
            "denies %s without writes",
            async (operation) => {
                const before = await db.select().from(resources).orderBy(asc(resources.id));
                await expect(
                    client[operation]({ projectId: deniedProjectId, name: "Injected" }),
                ).rejects.toMatchObject({ code: "NOT_FOUND" });
                expect(await db.select().from(resources).orderBy(asc(resources.id))).toEqual(
                    before,
                );
                expect(fetch).not.toHaveBeenCalled();
            },
        );
    });

    it.each(["updateSettings", "updateVariables", "updateDetails"] as const)(
        "rejects %s on a non-compose resource without mutation",
        async (operation) => {
            const row = await resource({ type: "other" });
            await expect(
                client[operation]({
                    projectId,
                    resourceId: row.id,
                    prefixNames: false,
                    env: "INJECTED=1",
                    name: "Injected",
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await storedResource(row.id)).toEqual(row);
        },
    );

    it.each(["updateSettings", "updateVariables"] as const)(
        "%s preserves unrelated settings, details, Compose, and Git metadata",
        async (operation) => {
            const row = await resource();

            const updated = await client[operation]({
                projectId,
                resourceId: row.id,
                prefixNames: false,
                env: "  RAW='value'\n# keep formatting\n",
            });

            const expectedSettings =
                operation === "updateSettings"
                    ? { ...settings, prefixNames: false }
                    : { ...settings, env: "  RAW='value'\n# keep formatting\n" };

            expect(updated).toEqual({
                ...row,
                settings: expectedSettings,
                updatedAt: expect.any(Date),
            });
            expect(updated.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
            expect(await storedResource(row.id)).toEqual(updated);
        },
    );

    it.each(["updateSettings", "updateVariables"] as const)(
        "%s initializes null settings",
        async (operation) => {
            const row = await resource({ settings: null });

            const updated = await client[operation]({
                projectId,
                resourceId: row.id,
                prefixNames: false,
                env: "",
            });

            expect(updated).toEqual({
                ...row,
                settings: operation === "updateSettings" ? { prefixNames: false } : { env: "" },
                updatedAt: expect.any(Date),
            });
            expect(await storedResource(row.id)).toEqual(updated);
        },
    );

    it("clears variables without discarding other settings", async () => {
        const row = await resource();
        const updated = await client.updateVariables({ projectId, resourceId: row.id, env: "" });
        expect(await storedResource(row.id)).toEqual({
            ...row,
            settings: { ...settings, env: "" },
            updatedAt: updated.updatedAt,
        });
    });

    it.each([null, settings])(
        "preserves both concurrent settings and variables edits starting from %j",
        async (initialSettings) => {
            const row = await resource({ settings: initialSettings });
            const lock = await db.$client.connect();
            await lock.query("BEGIN");
            await lock.query("SELECT id FROM resources WHERE id = $1 FOR UPDATE", [row.id]);

            const edits = Promise.allSettled([
                client.updateSettings({ projectId, resourceId: row.id, prefixNames: false }),
                client.updateVariables({ projectId, resourceId: row.id, env: "CONCURRENT=1\n" }),
            ]);

            try {
                // Hold both writes at the row lock so they really contend, rather than run serially.
                await expect
                    .poll(
                        async () => {
                            const result = await db.$client.query<{ count: number }>(
                                `SELECT count(*)::int AS count FROM pg_stat_activity
                                 WHERE datname = current_database() AND wait_event_type = 'Lock'
                                 AND query LIKE 'update "resources"%'`,
                            );

                            return result.rows[0]!.count;
                        },
                        { timeout: 3000 },
                    )
                    .toBe(2);
            } finally {
                await lock.query("ROLLBACK");
                lock.release();
                await edits;
            }

            expect((await edits).map((result) => result.status)).toEqual([
                "fulfilled",
                "fulfilled",
            ]);
            expect(await storedResource(row.id)).toEqual({
                ...row,
                settings: { ...initialSettings, prefixNames: false, env: "CONCURRENT=1\n" },
                updatedAt: expect.any(Date),
            });
        },
    );

    it("updates trimmed details while preserving settings, Compose, and Git metadata", async () => {
        const row = await resource();

        const updated = await client.updateDetails({
            projectId,
            resourceId: row.id,
            name: "  Renamed  ",
            description: "  New description  ",
            icon: "  new-icon  ",
        });

        expect(updated).toEqual({
            ...row,
            name: "Renamed",
            description: "New description",
            icon: "new-icon",
            updatedAt: expect.any(Date),
        });
        expect(await storedResource(row.id)).toEqual(updated);
    });

    it.each([
        { description: " \t ", icon: " \n " },
        { description: undefined, icon: undefined },
    ])("clears empty or omitted optional details: %j", async (details) => {
        const row = await resource();

        const updated = await client.updateDetails({
            projectId,
            resourceId: row.id,
            name: "Renamed",
            ...details,
        });

        expect(await storedResource(row.id)).toEqual({
            ...row,
            name: "Renamed",
            description: null,
            icon: null,
            updatedAt: updated.updatedAt,
        });
    });

    it.each([
        { name: "" },
        { name: " \t\n " },
        { name: "x".repeat(101) },
        { name: "Valid", description: "x".repeat(501) },
    ])("rejects invalid resource details %j without mutation", async (details) => {
        const row = await resource();
        await expect(
            client.updateDetails({ projectId, resourceId: row.id, ...details }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await storedResource(row.id)).toEqual(row);
    });

    it("previews the saved draft with editable settings without changing deployed source", async () => {
        const row = await resource({ settings: { prefixNames: false } });
        const preview = await client.getFormattedCompose({ projectId, resourceId: row.id });
        expect(preview).toMatchObject({
            prefix: undefined,
            serviceNames: ["draft"],
            serviceCount: 1,
        });
        expect(preview.yaml).toContain("busybox");
        expect(preview.yaml).not.toContain("nginx");
        expect(await storedResource(row.id)).toEqual(row);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        { draftSpec: null, code: "NOT_FOUND" },
        { draftSpec: "", code: "NOT_FOUND" },
        { draftSpec: "services: [broken", code: "BAD_REQUEST" },
    ])(
        "does not preview deployed Compose when the draft is unusable: %j",
        async ({ draftSpec, code }) => {
            const row = await resource({ draftSpec });
            await expect(
                client.getFormattedCompose({ projectId, resourceId: row.id }),
            ).rejects.toMatchObject({ code });
            expect(await storedResource(row.id)).toEqual(row);
        },
    );

    it.each([true, false])(
        "gets deployed containers with legacy prefixNames=%s when no snapshot exists",
        async (prefixNames) => {
            const row = await resource({
                spec: "services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n",
                settings: { prefixNames },
            });

            const webContainers = [{ id: "web-1" }, { id: "web-2" }];
            const workerContainers = [{ id: "worker-1" }];
            fetch.mockImplementation(async (request) =>
                Response.json({
                    containers:
                        String(request).endsWith("-web") || String(request).endsWith("/web")
                            ? webContainers
                            : workerContainers,
                }),
            );
            expect(
                await client.getContainers({ clusterId, projectId, resourceId: row.id }),
            ).toEqual([...webContainers, ...workerContainers]);
            const prefix = prefixNames ? `${projectId.slice(0, 8)}-${row.id.slice(0, 8)}-` : "";
            expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual([
                `http://owned.test/api/v1/services/${prefix}web`,
                `http://owned.test/api/v1/services/${prefix}worker`,
            ]);

            for (const [, options] of fetch.mock.calls) {
                expect(new Headers(options?.headers).get("authorization")).toBe(
                    "Bearer owned-token",
                );
                expect(options?.method).toBe("GET");
            }

            expect(await storedResource(row.id)).toEqual(row);
        },
    );

    it.each(["captured-prefix", ""])(
        "uses deployed source and latest ready snapshot prefix %j despite draft/settings edits",
        async (prefix) => {
            const row = await resource();
            const other = await resource();

            for (const entry of [
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-04",
                    finished: "2025-01-04",
                    prefix: "older-finish",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-01",
                    finished: "2025-01-05",
                    prefix: "older-created",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-02",
                    finished: "2025-01-05",
                    prefix,
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "failed",
                    created: "2025-01-06",
                    finished: "2025-01-06",
                    prefix: "failed",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "cancelled",
                    created: "2025-01-07",
                    finished: "2025-01-07",
                    prefix: "cancelled",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "queued",
                    created: "2025-01-08",
                    finished: null,
                    prefix: "queued",
                },
                {
                    resourceId: row.id,
                    name: "InitializeCluster",
                    status: "ready",
                    created: "2025-01-09",
                    finished: "2025-01-09",
                    prefix: "wrong-job",
                },
                {
                    resourceId: other.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-10",
                    finished: "2025-01-10",
                    prefix: "other-resource",
                },
            ]) {
                const id = randomUUID();
                await db.insert(deployments).values({
                    id,
                    jobId: id,
                    clusterId,
                    resourceId: entry.resourceId,
                    name: entry.name,
                    status: entry.status,
                    createdAt: new Date(entry.created),
                    finishedAt: entry.finished ? new Date(entry.finished) : null,
                });
                await db.insert(resourceDeploymentInputs).values({
                    deploymentId: id,
                    spec: entry.status === "ready" ? spec : draftSpec,
                    prefix: entry.prefix,
                });
            }

            await client.updateComposeSpec({
                projectId,
                resourceId: row.id,
                spec: "services: [invalid draft",
                expectedSpec: draftSpec,
                expectedSource: { connectionId: gitConnectionId, ...gitSource },
            });
            await client.updateSettings({
                projectId,
                resourceId: row.id,
                prefixNames: prefix === "",
            });
            fetch.mockResolvedValue(Response.json({ containers: [{ id: "deployed-web" }] }));
            expect(
                await client.getContainers({ clusterId, projectId, resourceId: row.id }),
            ).toEqual([{ id: "deployed-web" }]);
            expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
                `http://owned.test/api/v1/services/${prefix ? `${prefix}-` : ""}web`,
            ]);
            expect(await storedResource(row.id)).toMatchObject({
                spec,
                draftSpec: "services: [invalid draft",
            });
        },
    );

    it("rejects a mismatched same-organization cluster before external IO", async () => {
        fetch.mockResolvedValue(Response.json({ containers: [] }));
        await expect(
            client.getContainers({ clusterId: otherClusterId, projectId, resourceId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        ["foreign", foreignClusterId],
        ["missing", randomUUID()],
    ])("rejects a %s cluster before external IO", async (_label, deniedClusterId) => {
        await expect(
            client.getContainers({ clusterId: deniedClusterId, projectId, resourceId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("omits sidecar 404s while retaining containers from other services", async () => {
        const row = await resource({
            spec: "services:\n  web:\n    image: nginx\n  missing:\n    image: busybox\n",
            settings: { prefixNames: false },
        });

        fetch.mockImplementation(async (request) =>
            String(request).endsWith("/missing")
                ? Response.json({ error: "Service not found" }, { status: 404 })
                : Response.json({ containers: [{ id: "web-1" }] }),
        );
        expect(await client.getContainers({ clusterId, projectId, resourceId: row.id })).toEqual([
            { id: "web-1" },
        ]);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("propagates sidecar errors instead of reporting an empty container list", async () => {
        fetch.mockResolvedValue(Response.json({ error: "Sidecar unavailable" }, { status: 503 }));
        await expect(client.getContainers({ clusterId, projectId, resourceId })).rejects.toThrow(
            "Sidecar unavailable",
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        { spec: null, code: "NOT_FOUND" },
        { spec: "", code: "NOT_FOUND" },
        { spec: "services: [broken", code: "BAD_REQUEST" },
    ])("rejects unusable Compose before external IO: %j", async ({ spec, code }) => {
        const row = await resource({ spec });
        await expect(
            client.getContainers({ clusterId, projectId, resourceId: row.id }),
        ).rejects.toMatchObject({ code });
        expect(fetch).not.toHaveBeenCalled();
    });
});
