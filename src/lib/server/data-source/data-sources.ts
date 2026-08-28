// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";

import { and, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, member, services, workspace } from "#lib/db/schema";
import {
  composeServiceName,
  discoverComposeFiles,
  repositoryName,
} from "#lib/server/data-source/discovery";
import { createWorkspaceFolder, workspacePath } from "#lib/server/data-source/paths";
import { getRepo } from "#lib/server/shared/git";
import { uniqueSlug } from "#lib/server/shared/slugs";

export interface DataSourceDiscoveryResult {
  dataSourceId: string;
  discovered: number;
  existing: number;
  imported: number;
  repositoryName: string;
  skipped: number;
  workspaceId: string | null;
}

export const listDataSources = async (userId: string) => {
  const rows = await db
    .select({ dataSource })
    .from(dataSource)
    .innerJoin(member, eq(member.organizationId, dataSource.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(dataSource.createdAt);

  return rows.map((row) => row.dataSource).toReversed();
};

export const createDataSource = async (url: string, uncloudUrl: string, organizationId: string) => {
  const [created] = await db
    .insert(dataSource)
    .values({ organizationId, uncloudUrl, url })
    .returning();

  if (!created) {
    throw new Error("Unable to create data source");
  }

  return created;
};

export const deleteDataSource = async (id: string) => {
  const linkedWorkspaces = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.dataSourceId, id));

  if (linkedWorkspaces.length > 0) {
    const noun = linkedWorkspaces.length === 1 ? "workspace" : "workspaces";
    throw new Error(
      `Data source has ${linkedWorkspaces.length} ${noun}; delete them before deleting the data source`,
    );
  }

  const [deleted] = await db.delete(dataSource).where(eq(dataSource.id, id)).returning();

  if (!deleted) {
    throw new Error("Data source not found");
  }

  return [deleted];
};

export const discoverDataSource = async (id: string): Promise<DataSourceDiscoveryResult> => {
  const [source] = await db.select().from(dataSource).where(eq(dataSource.id, id));

  if (!source) {
    throw new Error("Data source not found");
  }

  const name = repositoryName(source.url);

  const [foundWorkspace] = await db
    .select()
    .from(workspace)
    .where(
      and(
        eq(workspace.dataSourceId, source.id),
        eq(workspace.name, name),
        eq(workspace.organizationId, source.organizationId),
      ),
    )
    .limit(1);

  let targetWorkspace = foundWorkspace;
  let createdWorkspaceId: string | null = null;

  if (!targetWorkspace) {
    const slug = await uniqueSlug(name, async (candidate) => {
      const matches = await db
        .select({ slug: workspace.slug })
        .from(workspace)
        .where(eq(workspace.slug, candidate));

      return matches.length > 0;
    });

    const [createdWorkspace] = await db
      .insert(workspace)
      .values({
        dataSourceId: source.id,
        name,
        organizationId: source.organizationId,
        slug,
      })
      .returning();

    if (!createdWorkspace) {
      throw new Error("Unable to create discovery workspace");
    }

    targetWorkspace = createdWorkspace;
    createdWorkspaceId = createdWorkspace.id;
  }

  const repoPath = workspacePath(targetWorkspace.id);
  await getRepo({ repoPath, repoUrl: source.url });

  const discovery = await discoverComposeFiles(repoPath);

  if (discovery.files.length === 0) {
    // Roll back a workspace that was only created for this discovery run.
    if (createdWorkspaceId) {
      await db.delete(workspace).where(eq(workspace.id, createdWorkspaceId));
      await fs.rm(repoPath, { force: true, recursive: true });
    }

    return {
      dataSourceId: source.id,
      discovered: 0,
      existing: 0,
      imported: 0,
      repositoryName: name,
      skipped: discovery.skipped.length,
      workspaceId: null,
    };
  }

  const existingServices = await db
    .select()
    .from(services)
    .where(eq(services.workspaceId, targetWorkspace.id));
  const generatedComposePaths = new Set(
    existingServices.flatMap((service) => [
      `${targetWorkspace.slug}/${service.slug}/compose.yaml`,
      `${targetWorkspace.id}/${service.slug}/compose.yaml`,
    ]),
  );

  let existing = 0;
  let imported = 0;

  for (const file of discovery.files) {
    if (generatedComposePaths.has(file.relativePath)) {
      continue;
    }

    const alreadyImported = existingServices.some(
      (service) => service.settings?.sourcePath === file.relativePath,
    );

    if (alreadyImported) {
      existing += 1;
      continue;
    }

    const serviceName = composeServiceName(file.relativePath);
    const slug = await uniqueSlug(serviceName, async (candidate) => {
      const matches = await db
        .select({ slug: services.slug })
        .from(services)
        .where(eq(services.slug, candidate));

      return matches.length > 0;
    });
    const [createdService] = await db
      .insert(services)
      .values({
        name: serviceName,
        settings: { sourcePath: file.relativePath },
        slug,
        type: "compose",
        value: file.compose,
        workspaceId: targetWorkspace.id,
      })
      .returning();

    if (!createdService) {
      throw new Error(`Unable to import ${file.relativePath}`);
    }

    await createWorkspaceFolder(repoPath, targetWorkspace.slug, createdService.slug ?? slug);
    existingServices.push(createdService);
    imported += 1;
  }

  return {
    dataSourceId: source.id,
    discovered: discovery.files.length,
    existing,
    imported,
    repositoryName: name,
    skipped: discovery.skipped.length,
    workspaceId: targetWorkspace.id,
  };
};
