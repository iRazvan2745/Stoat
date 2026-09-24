import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import {
    clusters,
    deployments,
    projects,
    resources,
    resourceDeploymentInputs,
} from "@stoat/db/schema/index";
import * as runtime from "@stoat/workflows/runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";

describe("resource deployment API", () => {
    const databaseName = `stoat_deploy_api_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const draftSpec = '# Keep raw YAML\nservices:\n  web:\n    image: "nginx"\n';
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    const enqueue = vi.spyOn(runtime, "queueResourceDeployment").mockResolvedValue();

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('deployer', 'Deployer', 'deployer@example.test')`,
        );

        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'deployer'`,
        );

        const organizationId: string = membership.rows[0].organization_id;
        // SAFETY: authorization reads only identity and active organization.
        context = {
            db,
            session: {
                user: { id: "deployer" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
    }, 30_000);

    afterAll(async () => {
        enqueue.mockRestore();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    async function resource(
        draft: string | null = draftSpec,
        settings = {},
        spec: string | null = null,
    ) {
        const id = randomUUID();
        await db
            .insert(resources)
            .values({ id, name: "Resource", projectId, draftSpec: draft, spec, settings });

        return { projectId, resourceId: id };
    }

    it.each([null, "services:\n  deployed:\n    image: busybox\n"])(
        "captures the saved draft without changing deployed spec %j and immediately queues only its ID",
        async (spec) => {
            const input = await resource(undefined, {}, spec);
            const result = await call(resourcesRouter.deploy, input, { context });
            expect(result.status).toBe("queued");
            expect(enqueue).toHaveBeenLastCalledWith(result.id);

            const [deployment] = await db
                .select()
                .from(deployments)
                .where(eq(deployments.id, result.id));

            expect(deployment).toMatchObject({
                jobId: result.id,
                clusterId,
                resourceId: input.resourceId,
                name: "DeployResource",
            });

            const [queuedResource] = await db
                .select()
                .from(resources)
                .where(eq(resources.id, input.resourceId));

            expect(queuedResource).toMatchObject({ spec, draftSpec });

            const saved = await call(
                resourcesRouter.updateComposeSpec,
                {
                    ...input,
                    spec: "changed later",
                    expectedSpec: draftSpec,
                    expectedSource: null,
                },
                { context },
            );

            expect(saved).toMatchObject({ spec, draftSpec: "changed later" });
            await call(
                resourcesRouter.updateSettings,
                { ...input, prefixNames: false },
                { context },
            );

            const [snapshot] = await db
                .select()
                .from(resourceDeploymentInputs)
                .where(eq(resourceDeploymentInputs.deploymentId, result.id));

            expect(snapshot).toEqual({
                deploymentId: result.id,
                spec: draftSpec,
                prefix: `${projectId.slice(0, 8)}-${input.resourceId.slice(0, 8)}`,
            });
            expect(deployment).not.toHaveProperty("spec");
        },
    );

    it("keeps the durable snapshot when immediate enqueue fails and respects disabled prefixing", async () => {
        const input = await resource(undefined, { prefixNames: false });
        enqueue.mockRejectedValueOnce(new Error("Queue offline"));
        const result = await call(resourcesRouter.deploy, input, { context });

        const [snapshot] = await db
            .select()
            .from(resourceDeploymentInputs)
            .where(eq(resourceDeploymentInputs.deploymentId, result.id));

        expect(snapshot?.prefix).toBe("");

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, result.id));

        expect(deployment?.status).toBe("queued");
    });

    it("serializes simultaneous requests for the same resource", async () => {
        const input = await resource();

        const results = await Promise.allSettled([
            call(resourcesRouter.deploy, input, { context }),
            call(resourcesRouter.deploy, input, { context }),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.find((result) => result.status === "rejected")).toMatchObject({
            reason: { code: "CONFLICT" },
        });
    });

    it("rejects empty/invalid Compose, wrong projects, internal resources and non-admins", async () => {
        for (const spec of [null, "", "services: {}", "services: [bad"]) {
            const input = await resource(spec, {}, draftSpec);
            await expect(call(resourcesRouter.deploy, input, { context })).rejects.toMatchObject({
                code: "BAD_REQUEST",
            });
            expect(
                await db
                    .select()
                    .from(deployments)
                    .where(eq(deployments.resourceId, input.resourceId)),
            ).toEqual([]);
        }

        const input = await resource();
        await expect(
            call(resourcesRouter.deploy, { ...input, projectId: randomUUID() }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await db.update(projects).set({ isInternal: true }).where(eq(projects.id, projectId));
        await expect(call(resourcesRouter.deploy, input, { context })).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await db.update(projects).set({ isInternal: false }).where(eq(projects.id, projectId));
        await db.$client.query(`UPDATE member SET role = 'member' WHERE user_id = 'deployer'`);
        await expect(call(resourcesRouter.deploy, input, { context })).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });
});
