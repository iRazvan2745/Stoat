// oxlint-disable no-await-in-loop
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";

import type { DeploymentSnapshot } from "#lib/server/deployments/deployment-snapshot";

const fixture = vi.hoisted(() => ({
    root: "",
    snapshots: [] as DeploymentSnapshot[],
    processedCommits: [] as (string | undefined)[],
    queueGate: Promise.resolve(),
}));

vi.mock("#lib/server/deployments/deployment-prepare", () => ({
    prepareDeployment: async (snapshot: DeploymentSnapshot) => {
        await fixture.queueGate;
        fixture.processedCommits.push(snapshot.gitCommit);
    },
}));

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
vi.mock("#lib/server/data-sources/paths", () => ({
    gitSourcePath: (sourceId: string) => path.join(fixture.root, "checkouts", sourceId),
}));
vi.mock("#lib/server/deployments/deployments", async () => {
    const { db } = await import("#lib/db");
    const { deployments } = await import("#lib/db/schema");
    return {
        enqueueDeployment: async (
            snapshot: DeploymentSnapshot,
            options: { deploymentId?: string } = {},
        ) => {
            const deploymentId = options.deploymentId ?? crypto.randomUUID();
            const created = await db
                .insert(deployments)
                .values({
                    id: deploymentId,
                    jobId: deploymentId,
                    resourceId: snapshot.resource.id,
                    gitCommit: snapshot.gitCommit,
                })
                .onConflictDoNothing()
                .returning();
            if (created.length > 0) fixture.snapshots.push(structuredClone(snapshot));
            return { deploymentId, jobId: deploymentId };
        },
    };
});

const { db } = await import("#lib/db");
const { dataSource, gitSource, organization, resources, workspace } =
    await import("#lib/db/schema");
const { captureDeploymentSnapshot } = await import("#lib/server/deployments/deployment-snapshot");
const { exportGitCompose, readGitCompose } = await import("#lib/server/git-sources/compose");
const { headCommit, writeRepositoryFile } = await import("#lib/server/git-sources/repository");
const { publishResourceDeployment, syncGitSource } = await import("#lib/server/git-sources/sync");

beforeAll(async () => {
    fixture.root = await mkdtemp(path.join(tmpdir(), "stoat-git-integration-"));
    await db.$client.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const folder of (await readdir("drizzle")).toSorted()) {
        const sql = await readFile(path.join("drizzle", folder, "migration.sql"), "utf8");
        await db.$client.unsafe(sql);
    }
});

afterAll(async () => {
    await db.$client.end();
    await rm(fixture.root, { force: true, recursive: true });
});

it("syncs both directions, preserves each commit snapshot, and does not enqueue duplicates", async () => {
    const id = crypto.randomUUID();
    const remote = path.join(fixture.root, `remote-${id}.git`);
    const author = path.join(fixture.root, `author-${id}`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(remote);
    await simpleGit(remote).init(true, { "--initial-branch": "main" });
    await simpleGit().clone(remote, author);
    const repo = simpleGit(author);
    await repo.addConfig("user.name", "Repository editor");
    await repo.addConfig("user.email", "editor@localhost");
    const [org] = await db
        .insert(organization)
        .values({ id, name: "Test", slug: id, createdAt: new Date() })
        .returning();
    if (!org) throw new Error("Missing test organization");
    const [source] = await db
        .insert(gitSource)
        .values({ name: "Repo", organizationId: org.id, url: remote })
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
    const [resource] = await db
        .insert(resources)
        .values({
            workspaceId: wrk.id,
            name: "Web",
            slug: `web-${id}`,
            value: "# clanker\nservices:\n  web:\n    image: nginx:1\n",
            settings: {},
        })
        .returning();
    if (!resource) throw new Error("Missing test resource");
    const composePath = `${wrk.slug}/${resource.slug}/compose.yaml`;
    await writeRepositoryFile(author, composePath, exportGitCompose(resource, wrk));
    await repo.add(".");
    await repo.commit("Initial config");
    await repo.push(["--set-upstream", "origin", "main"]);
    const initial = await syncGitSource(source.id);
    expect(initial.issues).toEqual([]);
    expect(initial.deployments).toBe(1);
    const revisions: string[] = [];
    for (const version of [2, 3]) {
        await writeRepositoryFile(
            author,
            composePath,
            exportGitCompose(
                {
                    ...resource,
                    value: resource.value?.replace("nginx:1", `nginx:${version}`) ?? "",
                },
                wrk,
            ),
        );
        await repo.add(".");
        await repo.commit(`Change to ${version}`);
        revisions.push((await headCommit(repo)) ?? "");
    }
    await repo.push();
    const synced = await syncGitSource(source.id);
    expect(synced.issues).toEqual([]);
    expect(synced.commits).toBe(2);
    expect(synced.deployments).toBe(2);
    const snapshots = fixture.snapshots.filter((snapshot) => snapshot.resource.id === resource.id);
    expect(snapshots.slice(-2).map((snapshot) => snapshot.gitCommit)).toEqual(revisions);
    expect(snapshots.at(-2)?.resource.value).toContain("nginx:2");
    expect(snapshots.at(-1)?.resource.value).toContain("nginx:3");
    const [updated] = await db.select().from(resources).where(eq(resources.id, resource.id));
    expect(updated?.value).toContain("  web:");
    expect(updated?.value).not.toContain(`${resource.slug}-web:`);
    expect(updated?.value).toContain("# clanker");
    const noChanges = await syncGitSource(source.id);
    expect(noChanges).toMatchObject({ commits: 0, deployments: 0, exported: 0, issues: [] });
    await db
        .update(resources)
        .set({ value: resource.value?.replace("nginx:1", "nginx:4") })
        .where(eq(resources.id, resource.id));
    const appSync = await syncGitSource(source.id);
    expect(appSync.issues).toEqual([]);
    expect(appSync.exported).toBe(1);
    expect(appSync.deployments).toBe(1);
    await repo.pull(["--ff-only"]);
    expect(await readFile(path.join(author, composePath), "utf8")).toContain(
        `${resource.slug}-web:`,
    );
    expect(readGitCompose(await readFile(path.join(author, composePath), "utf8")).raw).toContain(
        "nginx:4",
    );
    expect((await syncGitSource(source.id)).deployments).toBe(0);
    // Manual redeploys retain the commit even when there is no new configuration.
    const snapshot = await captureDeploymentSnapshot(resource.id);
    await publishResourceDeployment(snapshot);
    expect(fixture.snapshots.at(-1)?.gitCommit).toBe(await headCommit(repo));
    // Invalid history produces a failed snapshot, but a subsequent fix is not skipped or blocked.
    await writeRepositoryFile(author, composePath, "services: [broken");
    await repo.add(".");
    await repo.commit("Broken config");
    const invalidCommit = await headCommit(repo);
    await writeRepositoryFile(
        author,
        composePath,
        exportGitCompose(
            { ...resource, value: resource.value?.replace("nginx:1", "nginx:5") ?? "" },
            wrk,
        ),
    );
    await repo.add(".");
    await repo.commit("Fix config");
    await repo.push();
    const fixed = await syncGitSource(source.id);
    expect(fixed.deployments).toBe(2);
    expect(fixed.commits).toBe(2);
    expect(
        fixture.snapshots.find((item) => item.gitCommit === invalidCommit)?.gitValidationError,
    ).toBe("Invalid Compose YAML");
    expect(fixture.snapshots.at(-1)?.resource.value).toContain("nginx:5");
    // Concurrent edits stop at the conflicting commit without overwriting the app.
    await db
        .update(resources)
        .set({ value: resource.value?.replace("nginx:1", "nginx:local") })
        .where(eq(resources.id, resource.id));
    await writeRepositoryFile(
        author,
        composePath,
        exportGitCompose(
            { ...resource, value: resource.value?.replace("nginx:1", "nginx:remote") ?? "" },
            wrk,
        ),
    );
    await repo.add(".");
    await repo.commit("Conflicting remote edit");
    await repo.push();
    const conflict = await syncGitSource(source.id);
    expect(conflict.issues.join(" ")).toContain("Both the app and Git differ");
    expect(conflict.deployments).toBe(0);
    const [preserved] = await db.select().from(resources).where(eq(resources.id, resource.id));
    expect(preserved?.value).toContain("nginx:local");
    const resolved = await syncGitSource(source.id, "app");
    expect(resolved.issues).toEqual([]);
    expect(resolved.deployments).toBe(2);
    expect(fixture.snapshots.at(-2)?.resource.value).toContain("nginx:remote");
    expect(fixture.snapshots.at(-1)?.resource.value).toContain("nginx:local");
    expect((await syncGitSource(source.id)).deployments).toBe(0);
});

it("imports a structured repository into matching workspace and group folders once", async () => {
    const id = crypto.randomUUID();
    const remote = path.join(fixture.root, `import-${id}.git`);
    const author = path.join(fixture.root, `import-author-${id}`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(remote);
    await simpleGit(remote).init(true, { "--initial-branch": "main" });
    await simpleGit().clone(remote, author);
    const repo = simpleGit(author);
    await repo.addConfig("user.name", "Test");
    await repo.addConfig("user.email", "test@localhost");
    await writeRepositoryFile(
        author,
        "production/Customer%20apps/web/compose.yaml",
        "services:\n  web:\n    image: nginx:1\n",
    );
    await writeRepositoryFile(
        author,
        "staging/db/compose.yaml",
        "services:\n  db:\n    image: postgres:18\n",
    );
    await repo.add(".");
    await repo.commit("Import two workspaces");
    await repo.push(["--set-upstream", "origin", "main"]);
    await db.insert(organization).values({ id, name: "Import", slug: id, createdAt: new Date() });
    const [source] = await db
        .insert(gitSource)
        .values({ name: "Import", organizationId: id, url: remote })
        .returning();
    if (!source) throw new Error("Missing source");
    const [cluster] = await db
        .insert(dataSource)
        .values({
            organizationId: id,
            gitSourceId: source.id,
            uncloudUrl: "http://never-called.invalid",
        })
        .returning();
    if (!cluster) throw new Error("Missing cluster");
    const result = await syncGitSource(source.id);
    expect(result.issues).toEqual([]);
    expect(result.imported).toBe(2);
    const workspaces = await db
        .select()
        .from(workspace)
        .where(eq(workspace.dataSourceId, cluster.id));
    expect(
        workspaces
            .map((item) => item.name)
            .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["production", "staging"]);
    const production = workspaces.find((item) => item.name === "production");
    const [web] = await db
        .select()
        .from(resources)
        .where(eq(resources.workspaceId, production?.id ?? ""));
    expect(web?.groupName).toBe("Customer apps");
    expect(web?.settings.shouldPrefix).toBe(false);
    const again = await syncGitSource(source.id);
    expect(again).toMatchObject({ imported: 0, deployments: 0, commits: 0, issues: [] });
    if (!web) throw new Error("Missing imported resource");
    await db.delete(resources).where(eq(resources.id, web.id));
    await repo.pull(["--ff-only"]);
    await writeRepositoryFile(author, "README.md", "Another repository change\n");
    await repo.add("README.md");
    await repo.commit("Update documentation after deleting the app resource");
    await repo.push();
    const afterDelete = await syncGitSource(source.id);
    expect(afterDelete.imported).toBe(0);
    expect(afterDelete.issues.join(" ")).toContain("was not recreated");
    expect(
        await db
            .select()
            .from(resources)
            .where(eq(resources.workspaceId, production?.id ?? "")),
    ).toEqual([]);
});

it("initializes an empty remote from app configuration and serializes concurrent syncs", async () => {
    const id = crypto.randomUUID();
    const remote = path.join(fixture.root, `empty-${id}.git`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(remote);
    await simpleGit(remote).init(true, { "--initial-branch": "main" });
    await db.insert(organization).values({ id, name: "Empty", slug: id, createdAt: new Date() });
    const [source] = await db
        .insert(gitSource)
        .values({ name: "Empty", organizationId: id, url: remote })
        .returning();
    if (!source) throw new Error("Missing source");
    const [cluster] = await db
        .insert(dataSource)
        .values({
            organizationId: id,
            gitSourceId: source.id,
            uncloudUrl: "http://never-called.invalid",
        })
        .returning();
    if (!cluster) throw new Error("Missing cluster");
    expect((await syncGitSource(source.id)).issues).toEqual([]);
    const [wrk] = await db
        .insert(workspace)
        .values({ dataSourceId: cluster.id, organizationId: id, name: "Apps", slug: `apps-${id}` })
        .returning();
    if (!wrk) throw new Error("Missing workspace");
    const [resource] = await db
        .insert(resources)
        .values({
            workspaceId: wrk.id,
            name: "App",
            slug: `app-${id}`,
            groupName: "Tools",
            value: "services:\n  web:\n    image: nginx:1\n",
        })
        .returning();
    if (!resource) throw new Error("Missing resource");
    const results = await Promise.all([syncGitSource(source.id), syncGitSource(source.id)]);
    expect(results.flatMap((result) => result.issues)).toEqual([]);
    expect(results.reduce((total, result) => total + result.deployments, 0)).toBe(1);
    const files = await simpleGit(remote).raw(["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(files).toContain(`${wrk.slug}/Tools/${resource.slug}/compose.yaml`);
    await db.update(resources).set({ groupName: "Utilities" }).where(eq(resources.id, resource.id));
    expect((await syncGitSource(source.id)).issues).toEqual([]);
    const movedFiles = await simpleGit(remote).raw(["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(movedFiles).toContain(`${wrk.slug}/Utilities/${resource.slug}/compose.yaml`);
    expect(movedFiles).not.toContain("/Tools/");
    const editor = path.join(fixture.root, `move-editor-${id}`);
    await simpleGit().clone(remote, editor);
    const repo = simpleGit(editor);
    await repo.addConfig("user.name", "Test");
    await repo.addConfig("user.email", "test@localhost");
    await mkdir(path.join(editor, wrk.slug, "Operations"));
    await repo.mv(
        `${wrk.slug}/Utilities/${resource.slug}`,
        `${wrk.slug}/Operations/${resource.slug}`,
    );
    await repo.commit("Move group in Git");
    await repo.push();
    expect((await syncGitSource(source.id)).issues).toEqual([]);
    const [movedResource] = await db.select().from(resources).where(eq(resources.id, resource.id));
    expect(movedResource?.groupName).toBe("Operations");
    expect((await syncGitSource(source.id)).deployments).toBe(0);
});

it("queues separate commits for the same resource while the first deployment is still running", async () => {
    const queue = await vi.importActual<typeof import("#lib/server/deployments/deployments")>(
        "#lib/server/deployments/deployments",
    );
    const resourceId = fixture.snapshots.at(-1)?.resource.id;
    if (!resourceId) throw new Error("Missing queue fixture");
    const snapshot = await captureDeploymentSnapshot(resourceId);
    const gate = Promise.withResolvers<void>();
    fixture.queueGate = gate.promise;
    try {
        const first = await queue.enqueueDeployment({ ...snapshot, gitCommit: "1".repeat(40) });
        const second = await queue.enqueueDeployment({ ...snapshot, gitCommit: "2".repeat(40) });
        expect(first.jobId).not.toBe(second.jobId);
        expect(fixture.processedCommits).toEqual([]);
        gate.resolve();
        await vi.waitFor(
            () => {
                expect(fixture.processedCommits).toEqual(["1".repeat(40), "2".repeat(40)]);
            },
            { timeout: 10_000 },
        );
        const { deployments } = await import("#lib/db/schema");
        await vi.waitFor(
            async () => {
                const [record] = await db
                    .select()
                    .from(deployments)
                    .where(eq(deployments.id, second.deploymentId));
                expect(record?.outcome).toBe("success");
                expect(record?.gitCommit).toBe("2".repeat(40));
            },
            { timeout: 10_000 },
        );
        const redeploy = await queue.enqueueDeployment({ ...snapshot, gitCommit: "2".repeat(40) });
        expect(redeploy.deploymentId).not.toBe(second.deploymentId);
        await vi.waitFor(
            () => {
                expect(fixture.processedCommits).toEqual([
                    "1".repeat(40),
                    "2".repeat(40),
                    "2".repeat(40),
                ]);
            },
            { timeout: 10_000 },
        );
    } finally {
        gate.resolve();
        await queue.shutdownDeploymentWorker();
    }
});
