import { GitComposeError, GitSyncError } from "#lib/server/git-sources/errors";
// oxlint-disable no-await-in-loop
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import type { SimpleGit } from "simple-git";

import { db } from "#lib/db";
import { dataSource, deployments, gitSource, resources, workspace } from "#lib/db/schema";
import type { GitResourceSyncState, GitSyncResult } from "#lib/domain/git-sync";
import { repositoryName } from "#lib/server/data-sources/discovery";
import { gitSourcePath } from "#lib/server/data-sources/paths";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import { captureDeploymentSnapshot } from "#lib/server/deployments/deployment-snapshot";
import type { DeploymentSnapshot } from "#lib/server/deployments/deployment-snapshot";
import { enqueueDeployment } from "#lib/server/deployments/deployments";
import {
    canonicalComposePath,
    composeFingerprint,
    exportGitCompose,
    inferComposeLocation,
    readGitCompose,
    syncDirection,
} from "#lib/server/git-sources/compose";
import {
    commitRepositoryFiles,
    headCommit,
    pendingCommits,
    readCommitComposeFiles,
    validateRepositoryFilePath,
    writeRepositoryFile,
} from "#lib/server/git-sources/repository";
import type { RepositoryComposeFile } from "#lib/server/git-sources/repository";
import { withGitRepo } from "#lib/server/shared/git";
import { gitAuthenticationFromSource } from "#lib/server/shared/git-auth";
import { withGitSourceLock } from "#lib/server/shared/git-lock";
import { uniqueSlug } from "#lib/server/shared/slugs";

type Resource = typeof resources.$inferSelect;
type Workspace = typeof workspace.$inferSelect;
type Source = typeof gitSource.$inferSelect;
interface LinkedResource {
    resource: Resource;
    workspace: Workspace;
}
interface SyncContext {
    source: Source;
    repo: SimpleGit;
    root: string;
    result: GitSyncResult;
    cache: Map<string, string>;
    resolution?: "app" | "git";
}

const messageOf = (error: unknown): string =>
    error instanceof GitSyncError
        ? error.message
        : "Unable to synchronize this file; check its Compose configuration and deployment queue";
const addIssue = (context: SyncContext, message: string): void => {
    if (!context.result.issues.includes(message)) context.result.issues.push(message);
};

const listLinkedResources = async (sourceId: string): Promise<LinkedResource[]> =>
    await db
        .select({ resource: resources, workspace })
        .from(resources)
        .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
        .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
        .where(eq(dataSource.gitSourceId, sourceId));

const stateFor = (resource: Resource, sourceId: string): GitResourceSyncState | null =>
    resource.gitSync?.sourceId === sourceId ? resource.gitSync : null;

const pathFor = ({ resource, workspace: wrk }: LinkedResource, sourceId: string): string =>
    stateFor(resource, sourceId)?.path ??
    resource.settings.sourcePath ??
    canonicalComposePath(resource, wrk);

const findLinkedResource = (
    file: RepositoryComposeFile,
    linked: LinkedResource[],
    sourceId: string,
): LinkedResource | undefined => {
    const { metadata } = readGitCompose(file.compose);
    return (
        linked.find(({ resource }) => metadata?.resourceId === resource.id) ??
        linked.find((row) => pathFor(row, sourceId) === file.path) ??
        linked.find(
            ({ resource, workspace: wrk }) =>
                file.path === `${wrk.slug}/${resource.slug ?? resource.id}/compose.yaml`,
        )
    );
};

const importFile = async (
    context: SyncContext,
    file: RepositoryComposeFile,
): Promise<LinkedResource> => {
    const { metadata, raw } = readGitCompose(file.compose);
    const location = inferComposeLocation(
        file.path,
        repositoryName(context.source.url ?? "Repository"),
    );
    if (
        location.workspaceName.length > 128 ||
        location.resourceName.length > 128 ||
        (location.groupName?.length ?? 0) > 80
    )
        throw new GitComposeError("Workspace, resource, or group folder name is too long");
    const sources = await db
        .select()
        .from(dataSource)
        .where(eq(dataSource.gitSourceId, context.source.id));
    const workspaces = await db
        .select({ workspace })
        .from(workspace)
        .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
        .where(eq(dataSource.gitSourceId, context.source.id));
    let wrk =
        workspaces.find((row) => row.workspace.id === metadata?.workspaceId)?.workspace ??
        workspaces.find(
            (row) =>
                row.workspace.slug === location.workspaceName ||
                row.workspace.name === location.workspaceName,
        )?.workspace;
    if (!wrk) {
        const destination =
            sources.find((source) => source.id === metadata?.dataSourceId) ??
            (sources.length === 1 ? sources[0] : undefined);
        if (!destination)
            throw new GitSyncError(
                "Assign one cluster connection, or place this file under an existing workspace folder to select its cluster",
            );
        const name = metadata?.workspaceName ?? location.workspaceName;
        const slug = await uniqueSlug(
            name,
            async (candidate) =>
                (
                    await db
                        .select({ id: workspace.id })
                        .from(workspace)
                        .where(eq(workspace.slug, candidate))
                ).length > 0,
        );
        [wrk] = await db
            .insert(workspace)
            .values({
                dataSourceId: destination.id,
                organizationId: context.source.organizationId,
                name,
                slug,
            })
            .returning();
    }
    if (!wrk) throw new GitSyncError("Unable to create workspace");
    const name = metadata?.name ?? location.resourceName;
    const slug = await uniqueSlug(
        name,
        async (candidate) =>
            (
                await db
                    .select({ id: resources.id })
                    .from(resources)
                    .where(eq(resources.slug, candidate))
            ).length > 0,
    );
    const importedSlug = metadata?.slug ?? slug;
    const [occupied] = await db
        .select({ id: resources.id })
        .from(resources)
        .where(eq(resources.slug, importedSlug));
    if (occupied)
        throw new GitSyncError(
            "The Git resource slug is already used by another resource; choose a unique slug and matching formatted names",
        );
    const [resource] = await db
        .insert(resources)
        .values({
            workspaceId: wrk.id,
            name,
            slug: importedSlug,
            groupName: metadata?.groupName ?? location.groupName,
            icon: metadata?.icon,
            value: raw,
            settings: { sourcePath: file.path, shouldPrefix: metadata?.shouldPrefix ?? false },
        })
        .returning();
    if (!resource) throw new GitSyncError("Unable to import resource");
    resource.gitSync = {
        sourceId: context.source.id,
        path: file.path,
        appHash: composeFingerprint(exportGitCompose(resource, wrk)),
        repoHash: composeFingerprint(file.compose),
    };
    const [updated] = await db
        .update(resources)
        .set({ gitSync: resource.gitSync })
        .where(eq(resources.id, resource.id))
        .returning();
    if (!updated) throw new GitSyncError("Imported resource was removed during sync");
    context.result.imported += 1;
    return { resource: updated, workspace: wrk };
};

const updateFromCommit = async (
    context: SyncContext,
    row: LinkedResource,
    file: RepositoryComposeFile,
): Promise<{ raw: string; resource: Resource }> => {
    const { resource, workspace: wrk } = row;
    const prefix =
        resource.settings.shouldPrefix === false ? undefined : (resource.slug ?? resource.id);
    const decoded = readGitCompose(file.compose, prefix);
    const appExport = exportGitCompose(resource, wrk);
    const appHash = composeFingerprint(appExport);
    const repoHash = composeFingerprint(file.compose);
    const base = stateFor(resource, context.source.id);
    const legacyMatches =
        !decoded.metadata &&
        composeFingerprint(formatComposeFile(resource.value ?? "", prefix).yaml) ===
            composeFingerprint(decoded.formatted);
    const moved = Boolean(base && base.path !== file.path);
    const comparisonBase = moved && base ? { ...base, repoHash: "moved" } : base;
    let direction =
        legacyMatches && !moved ? "unchanged" : syncDirection(appHash, repoHash, comparisonBase);
    if (moved && direction === "unchanged") direction = "pull";
    if (direction === "conflict" && context.resolution)
        direction = context.resolution === "git" ? "pull" : "push";
    if (direction === "conflict") {
        throw new GitSyncError(
            "Both the app and Git differ. Reconcile the Compose/settings in the app with this Git version, then sync again; neither version was overwritten",
        );
    }
    const remoteResource: Resource = {
        ...resource,
        value: decoded.raw,
        ...(decoded.metadata
            ? {
                  name: decoded.metadata.name,
                  slug: decoded.metadata.slug,
                  icon: decoded.metadata.icon,
                  groupName: decoded.metadata.groupName,
                  settings: { ...resource.settings, shouldPrefix: decoded.metadata.shouldPrefix },
              }
            : {}),
    };
    const remotePrefix =
        remoteResource.settings.shouldPrefix === false
            ? undefined
            : (remoteResource.slug ?? remoteResource.id);
    if (
        composeFingerprint(formatComposeFile(decoded.raw, remotePrefix).yaml) !==
        composeFingerprint(decoded.formatted)
    ) {
        throw new GitComposeError(
            "Git Compose must use formatted service, volume, dependency and upstream names, including the configured prefix",
        );
    }
    let targetWorkspace = wrk;
    if (moved && direction === "pull") {
        const location = inferComposeLocation(
            file.path,
            repositoryName(context.source.url ?? "Repository"),
        );
        remoteResource.groupName = location.groupName;
        if (location.workspaceName !== wrk.slug && location.workspaceName !== wrk.name) {
            const candidates = await db
                .select({ workspace })
                .from(workspace)
                .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
                .where(eq(dataSource.gitSourceId, context.source.id));
            const existing = candidates.find(
                (candidate) =>
                    candidate.workspace.slug === location.workspaceName ||
                    candidate.workspace.name === location.workspaceName,
            )?.workspace;
            if (!existing)
                throw new GitSyncError(
                    "Create the destination workspace in the app before moving this Git folder",
                );
            targetWorkspace = existing;
            remoteResource.workspaceId = existing.id;
        }
    }
    const next = direction === "pull" ? remoteResource : resource;
    const gitSync: GitResourceSyncState = {
        sourceId: context.source.id,
        path: file.path,
        repoHash,
        appHash:
            direction === "push" && base
                ? base.appHash
                : composeFingerprint(exportGitCompose(next, targetWorkspace)),
    };
    const updated = await db
        .update(resources)
        .set({
            ...(direction === "pull"
                ? {
                      value: next.value,
                      name: next.name,
                      slug: next.slug,
                      icon: next.icon,
                      groupName: next.groupName,
                      settings: next.settings,
                      workspaceId: next.workspaceId,
                  }
                : {}),
            gitSync,
        })
        .where(and(eq(resources.id, resource.id), eq(resources.updatedAt, resource.updatedAt)))
        .returning();
    if (!updated[0])
        throw new GitSyncError("The resource changed while syncing; retry to use its latest edits");
    if (direction === "pull") context.result.updated += 1;
    return { raw: decoded.raw, resource: remoteResource };
};

const commitDeploymentId = (sourceId: string, resourceId: string, commit: string): string => {
    const hash = createHash("sha256").update(`${sourceId}:${resourceId}:${commit}`).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};

const deployCommitResource = async (
    context: SyncContext,
    resource: Resource,
    commit: string,
    gitCompose: string,
    gitValidationError?: string,
): Promise<void> => {
    const snapshot = await captureDeploymentSnapshot(resource.id);
    snapshot.resource = {
        ...snapshot.resource,
        groupName: resource.groupName,
        name: resource.name,
        slug: resource.slug,
        value: resource.value,
        icon: resource.icon,
        settings: resource.settings,
    };
    snapshot.gitCommit = commit;
    snapshot.gitCompose = gitCompose;
    snapshot.gitValidationError = gitValidationError;
    const deploymentId = commitDeploymentId(context.source.id, resource.id, commit);
    const [existing] = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.id, deploymentId));
    await enqueueDeployment(snapshot, { deploymentId });
    if (!existing) context.result.deployments += 1;
};

const processCommit = async (context: SyncContext, commit: string): Promise<boolean> => {
    const files = await readCommitComposeFiles(context.repo, commit, context.cache);
    const previousResourceIds = new Set<string>();
    if (context.source.lastSyncedCommit) {
        const previousFiles = await readCommitComposeFiles(
            context.repo,
            context.source.lastSyncedCommit,
            context.cache,
        );
        for (const file of previousFiles) {
            try {
                const metadata = readGitCompose(file.compose).metadata;
                if (metadata) previousResourceIds.add(metadata.resourceId);
            } catch {
                // A broken earlier file must not prevent importing its fixing commit.
            }
        }
    }
    const linked = await listLinkedResources(context.source.id);
    const seen = new Set<string>();
    let successful = true;
    for (const file of files) {
        let matched = linked.find((row) => pathFor(row, context.source.id) === file.path);
        try {
            let row = findLinkedResource(file, linked, context.source.id);
            if (!row) {
                const metadata = readGitCompose(file.compose).metadata;
                if (metadata && previousResourceIds.has(metadata.resourceId)) {
                    addIssue(
                        context,
                        `${file.path}: this resource was deleted in the app. Remove its Git file to complete the deletion; it was not recreated.`,
                    );
                    continue;
                }
                row = await importFile(context, file);
                linked.push(row);
            }
            matched = row;
            if (seen.has(row.resource.id))
                throw new GitSyncError("Multiple Compose files map to this resource");
            seen.add(row.resource.id);
            const prepared = await updateFromCommit(context, row, file);
            await deployCommitResource(
                context,
                prepared.resource,
                commit,
                readGitCompose(file.compose).formatted,
            );
        } catch (error) {
            if (error instanceof GitComposeError && matched) {
                seen.add(matched.resource.id);
                await deployCommitResource(
                    context,
                    matched.resource,
                    commit,
                    file.compose,
                    error.message,
                );
            } else if (!(error instanceof GitComposeError)) {
                successful = false;
            }
            addIssue(context, `${file.path} @ ${commit.slice(0, 8)}: ${messageOf(error)}`);
        }
    }
    for (const row of linked) {
        if (!seen.has(row.resource.id) && stateFor(row.resource, context.source.id)) {
            successful = false;
            addIssue(
                context,
                `${pathFor(row, context.source.id)} @ ${commit.slice(0, 8)}: file removed or renamed without its x-stoat identity. The app resource was preserved.`,
            );
        }
    }
    if (successful) {
        await db
            .update(gitSource)
            .set({ lastSyncedCommit: commit })
            .where(eq(gitSource.id, context.source.id));
        context.source.lastSyncedCommit = commit;
        context.result.commit = commit;
        context.result.commits += 1;
    }
    return successful;
};

const processHistory = async (context: SyncContext): Promise<boolean> => {
    const head = await headCommit(context.repo);
    for (const commit of await pendingCommits(
        context.repo,
        context.source.lastSyncedCommit,
        head,
    )) {
        if (!(await processCommit(context, commit))) return false;
    }
    return true;
};

const publishAppChanges = async (
    context: SyncContext,
    requestedResourceId?: string,
): Promise<void> => {
    const linked = await listLinkedResources(context.source.id);
    const head = await headCommit(context.repo);
    const files = head ? await readCommitComposeFiles(context.repo, head, context.cache) : [];
    const writes: { path: string; compose: string }[] = [];
    const removals: string[] = [];
    for (const row of linked) {
        if (requestedResourceId && row.resource.id !== requestedResourceId) continue;
        if (!row.resource.value) continue;
        const relativePath = pathFor(row, context.source.id);
        const currentFile = files.find((file) => file.path === relativePath);
        const compose = exportGitCompose(row.resource, row.workspace);
        if (currentFile && composeFingerprint(compose) === composeFingerprint(currentFile.compose))
            continue;
        const base = stateFor(row.resource, context.source.id);
        if (base && !currentFile)
            throw new GitSyncError(
                `Git deleted ${relativePath}; restore or reconcile it before publishing`,
            );
        if (base && currentFile && composeFingerprint(currentFile.compose) !== base.repoHash)
            throw new GitSyncError(`Git changed ${relativePath}; sync before publishing app edits`);
        const metadata = currentFile ? readGitCompose(currentFile.compose).metadata : null;
        const structureChanged =
            metadata &&
            (metadata.groupName !== (row.resource.groupName ?? null) ||
                metadata.workspaceId !== row.workspace.id ||
                metadata.workspaceSlug !== row.workspace.slug ||
                metadata.slug !== row.resource.slug);
        const targetPath = structureChanged
            ? canonicalComposePath(row.resource, row.workspace)
            : relativePath;
        if (targetPath !== relativePath) {
            if (files.some((file) => file.path === targetPath))
                throw new GitSyncError(`Another resource already uses ${targetPath}`);
            removals.push(relativePath);
        }
        if (writes.some((file) => file.path === targetPath))
            throw new GitSyncError(`Multiple resources map to ${targetPath}`);
        writes.push({ compose, path: targetPath });
    }
    // Complete validation before writing any file. Never stage unrelated repository content.
    for (const file of writes) await validateRepositoryFilePath(context.root, file.path);
    try {
        for (const file of writes) await writeRepositoryFile(context.root, file.path, file.compose);
        if (removals.length > 0)
            await context.repo.raw(["--literal-pathspecs", "rm", "--", ...removals]);
        if (writes.length > 0) {
            await commitRepositoryFiles(
                context.repo,
                writes.map((file) => file.path),
                "Sync formatted Compose configuration from Stoat",
            );
            context.result.exported += writes.length;
        }
    } catch (error) {
        // Before commit, restore only files this operation owns. After commit, keep
        // the commit so the next sync can retry its push without losing history.
        if ((await headCommit(context.repo)) === head) {
            const touched = [...writes.map((file) => file.path), ...removals];
            const existingPaths = touched.filter((relativePath) =>
                files.some((file) => file.path === relativePath),
            );
            const addedPaths = touched.filter(
                (relativePath) => !existingPaths.includes(relativePath),
            );
            if (existingPaths.length > 0 && head)
                await context.repo.raw([
                    "--literal-pathspecs",
                    "restore",
                    `--source=${head}`,
                    "--staged",
                    "--worktree",
                    "--",
                    ...existingPaths,
                ]);
            if (addedPaths.length > 0)
                await context.repo.raw([
                    "--literal-pathspecs",
                    "rm",
                    "--cached",
                    "--ignore-unmatch",
                    "--",
                    ...addedPaths,
                ]);
            for (const relativePath of addedPaths)
                await fs.rm(path.join(context.root, relativePath), { force: true });
        }
        throw error;
    }
};

const withSourceRepository = async <T>(
    sourceId: string,
    operation: (context: SyncContext) => Promise<T>,
): Promise<T> =>
    await withGitSourceLock(sourceId, async () => {
        const [source] = await db.select().from(gitSource).where(eq(gitSource.id, sourceId));
        if (!source?.url) throw new GitSyncError("Git Source has no repository URL");
        const root = gitSourcePath(sourceId);
        await fs.mkdir(path.dirname(root), { recursive: true });
        const result: GitSyncResult = {
            checkedAt: new Date().toISOString(),
            commit: source.lastSyncedCommit,
            commits: 0,
            deployments: 0,
            exported: 0,
            imported: 0,
            issues: [],
            updated: 0,
        };
        try {
            return await withGitRepo(
                {
                    authentication: gitAuthenticationFromSource(source),
                    repoPath: root,
                    repoUrl: source.url,
                },
                async (repo) => {
                    const status = await repo.status();
                    if (!status.isClean())
                        throw new GitSyncError(
                            "The Git Source checkout contains unfinished changes; resolve them before syncing",
                        );
                    // Retry a previous successful commit whose push failed; never force-push.
                    if (status.ahead > 0) await repo.push();
                    return await operation({ cache: new Map(), repo, result, root, source });
                },
            );
        } catch (error) {
            // Do not persist raw Git stderr: it can contain credential-bearing remote messages.
            const message =
                error instanceof GitSyncError
                    ? error.message
                    : "Repository sync failed. Check connectivity, repository access, and Git history.";
            result.issues.push(message);
            throw new GitSyncError(message);
        } finally {
            result.checkedAt = new Date().toISOString();
            await db
                .update(gitSource)
                .set({ syncResult: result })
                .where(eq(gitSource.id, sourceId));
        }
    });

export const syncGitSource = async (
    sourceId: string,
    resolution?: "app" | "git",
): Promise<GitSyncResult> =>
    await withSourceRepository(sourceId, async (context) => {
        context.resolution = resolution;
        if ((await processHistory(context)) && context.result.issues.length === 0) {
            await publishAppChanges(context);
            await processHistory(context);
        }
        return context.result;
    });

/** Git sync for a manual deployment snapshot. Mutates snapshot with commit/compose. */
export const attachGitCommitToSnapshot = async (snapshot: DeploymentSnapshot): Promise<string> =>
    await withSourceRepository(snapshot.git.id, async (context) => {
        const [current] = await db
            .select()
            .from(resources)
            .where(eq(resources.id, snapshot.resource.id));
        const [currentWorkspace] = current
            ? await db.select().from(workspace).where(eq(workspace.id, current.workspaceId))
            : [];
        if (
            !current ||
            !currentWorkspace ||
            exportGitCompose(current, currentWorkspace) !==
                exportGitCompose(snapshot.resource, snapshot.workspace)
        ) {
            throw new GitSyncError(
                "Resource configuration changed during Git sync. Refresh the resource before deploying.",
            );
        }
        await publishAppChanges(context, snapshot.resource.id);
        const commit = await headCommit(context.repo);
        if (!commit) throw new GitSyncError("The repository does not have a commit to deploy");
        snapshot.gitCommit = commit;
        snapshot.gitCompose = exportGitCompose(current, currentWorkspace);
        return commit;
    });

/** Publish before enqueue so the durable snapshot and deployment record have a commit. */
export const publishResourceDeployment = async (
    snapshot: DeploymentSnapshot,
): Promise<{ deploymentId: string; jobId: string }> => {
    const commit = await attachGitCommitToSnapshot(snapshot);
    const [source] = await db.select().from(gitSource).where(eq(gitSource.id, snapshot.git.id));
    if (source?.lastSyncedCommit !== commit) {
        const deploymentId = commitDeploymentId(snapshot.git.id, snapshot.resource.id, commit);
        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));
        if (!deployment) return await enqueueDeployment(snapshot, { deploymentId });
        if (!deployment.finishedAt)
            return { deploymentId, jobId: deployment.jobId ?? deploymentId };
    }
    // An explicit redeploy of unchanged configuration still records the same Git commit.
    return await enqueueDeployment(snapshot);
};
