// oxlint-disable no-await-in-loop
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";

vi.mock("#lib/db", async () => {
    const url = process.env.GIT_SYNC_TEST_DATABASE_URL;
    if (!url || new URL(url).pathname !== "/stoat_git_sync_test") {
        throw new Error(
            "Set GIT_SYNC_TEST_DATABASE_URL to an isolated database named stoat_git_sync_test; these tests reset its schema",
        );
    }
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    return { db: drizzle({ client: postgres(url) }) };
});

const { db } = await import("#lib/db");
const { dataSource, gitSource, organization, resources, workspace } =
    await import("#lib/db/schema");
const { updateResourceGroup, updateResourceGroupName, updateResourcePosition } =
    await import("#lib/server/resources/resource-groups");

const resourceOrder = async (resourceId: string) => {
    const [row] = await db
        .select({ groupName: resources.groupName, sortOrder: resources.sortOrder })
        .from(resources)
        .where(eq(resources.id, resourceId));
    if (!row) throw new Error("Missing test resource");
    return row;
};

const workspaceOrder = async (workspaceId: string) => {
    const rows = await db
        .select({
            groupName: resources.groupName,
            id: resources.id,
            sortOrder: resources.sortOrder,
        })
        .from(resources)
        .where(eq(resources.workspaceId, workspaceId))
        .orderBy(resources.sortOrder, resources.id);
    return rows.map((row) => ({ group: row.groupName, id: row.id, order: row.sortOrder }));
};

beforeAll(async () => {
    await db.$client.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const folder of (await readdir("drizzle")).toSorted()) {
        const sql = await readFile(path.join("drizzle", folder, "migration.sql"), "utf8");
        await db.$client.unsafe(sql);
    }
});

afterAll(async () => {
    await db.$client.end();
});

it("places resources at dropped positions, adopts groups, and renormalizes squeezed orders", async () => {
    const id = crypto.randomUUID();
    const [org] = await db
        .insert(organization)
        .values({ id, name: "Test", slug: id, createdAt: new Date() })
        .returning();
    if (!org) throw new Error("Missing test organization");
    const [source] = await db
        .insert(gitSource)
        .values({ name: "Repo", organizationId: org.id, url: "https://never-called.invalid" })
        .returning();
    if (!source) throw new Error("Missing test Git source");
    const [cluster] = await db
        .insert(dataSource)
        .values({
            organizationId: org.id,
            gitSourceId: source.id,
            uncloudUrl: "http://never-called.invalid",
        })
        .returning();
    if (!cluster) throw new Error("Missing test cluster");
    const [wrk] = await db
        .insert(workspace)
        .values({
            dataSourceId: cluster.id,
            organizationId: org.id,
            name: "Production",
            slug: `production-${id}`,
        })
        .returning();
    if (!wrk) throw new Error("Missing test workspace");

    const resourceRows = await db
        .insert(resources)
        .values([
            {
                groupName: null,
                name: "caddy",
                slug: `caddy-${id}`,
                sortOrder: 0,
                workspaceId: wrk.id,
            },
            {
                groupName: "Monitoring",
                name: "prometheus",
                slug: `prometheus-${id}`,
                sortOrder: 1024,
                workspaceId: wrk.id,
            },
            {
                groupName: "Monitoring",
                name: "grafana",
                slug: `grafana-${id}`,
                sortOrder: 2048,
                workspaceId: wrk.id,
            },
            {
                groupName: null,
                name: "ntfy",
                slug: `ntfy-${id}`,
                sortOrder: 3072,
                workspaceId: wrk.id,
            },
            // Fresh resource with no order yet, like one created via the UI.
            { groupName: null, name: "beszel", slug: `beszel-${id}`, workspaceId: wrk.id },
        ])
        .returning();
    if (resourceRows.length !== 5) throw new Error("Missing test resources");
    const [caddy, prometheus, grafana, ntfy, beszel] = resourceRows;
    if (!caddy || !prometheus || !grafana || !ntfy || !beszel) {
        throw new Error("Missing test resources");
    }

    // Drop "ntfy" right before "prometheus": it joins Monitoring in between.
    await updateResourcePosition(wrk.id, ntfy.id, prometheus.id, null);
    expect(await resourceOrder(ntfy.id)).toEqual({
        groupName: "Monitoring",
        sortOrder: 512,
    });

    // Append "caddy" to a brand new group; the pending beszel order gets
    // materialized behind the ordered resources first.
    await updateResourcePosition(wrk.id, caddy.id, null, "Media");
    expect(await resourceOrder(beszel.id)).toEqual({
        groupName: null,
        sortOrder: 4096,
    });
    expect(await resourceOrder(caddy.id)).toEqual({
        groupName: "Media",
        sortOrder: 5120,
    });

    // Drop "beszel" before "grafana" to slot it into the middle of Monitoring.
    await updateResourcePosition(wrk.id, beszel.id, grafana.id, null);
    expect(await resourceOrder(beszel.id)).toEqual({
        groupName: "Monitoring",
        sortOrder: 1536,
    });

    // Moving a resource directly before its current neighbor is a no-op.
    await updateResourcePosition(wrk.id, beszel.id, grafana.id, null);
    expect((await resourceOrder(beszel.id)).sortOrder).toBe(1536);

    // Squeeze two neighbors until there is no room left, then drop onto the
    // tight gap: orders renormalize with fresh spacing before the insert.
    await db.update(resources).set({ sortOrder: 1000 }).where(eq(resources.id, prometheus.id));
    await db.update(resources).set({ sortOrder: 1000.0000001 }).where(eq(resources.id, grafana.id));
    await updateResourcePosition(wrk.id, caddy.id, grafana.id, null);
    expect(await workspaceOrder(wrk.id)).toEqual([
        { group: "Monitoring", id: ntfy.id, order: 0 },
        { group: "Monitoring", id: prometheus.id, order: 1024 },
        { group: "Monitoring", id: caddy.id, order: 1536 },
        { group: "Monitoring", id: grafana.id, order: 2048 },
        { group: "Monitoring", id: beszel.id, order: 3072 },
    ]);

    // Ungroup via append, and via the dialog path.
    await updateResourcePosition(wrk.id, beszel.id, null, null);
    expect(await resourceOrder(beszel.id)).toEqual({
        groupName: null,
        sortOrder: 4096,
    });
    await updateResourceGroup(wrk.id, beszel.id, null);
    expect((await resourceOrder(beszel.id)).groupName).toBeNull();
    expect((await resourceOrder(beszel.id)).sortOrder).toBeGreaterThan(4096);

    // Renaming a group keeps every position untouched.
    await updateResourceGroupName(wrk.id, "Monitoring", "Observability");
    expect(await resourceOrder(prometheus.id)).toEqual({
        groupName: "Observability",
        sortOrder: 1024,
    });

    // Moving an unknown resource or target fails safely.
    await expect(updateResourcePosition(wrk.id, crypto.randomUUID(), null, null)).rejects.toThrow(
        "Resource is no longer in this workspace",
    );
    await expect(
        updateResourcePosition(wrk.id, caddy.id, crypto.randomUUID(), null),
    ).rejects.toThrow("Target resource is no longer in this workspace");
});
