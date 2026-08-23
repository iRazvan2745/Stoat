// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";

import { and, eq } from "drizzle-orm";

import { createDataSourceFolder, resolveDataSourcePath } from "#lib/server/data-source/paths";
import {
  composeServiceName,
  discoverComposeFiles,
  repositoryName,
} from "#lib/server/data-source/discovery";
import { db } from "#lib/server/db";
import { dataSource, services, workspace } from "#lib/server/db/schema";
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

export const listDataSources = async () => await db.select().from(dataSource);

export const createDataSource = async (url: string) => {
  const id = crypto.randomUUID();
  const dataSourcePath = id;

  const [created] = await db
    .insert(dataSource)
    .values({ id, path: dataSourcePath, url })
    .returning();

  if (!created) {
    throw new Error("Unable to create data source");
  }

  try {
    await createDataSourceFolder(resolveDataSourcePath(dataSourcePath));
  } catch (error) {
    await db.delete(dataSource).where(eq(dataSource.id, created.id));
    throw error;
  }

  return created;
};

export const deleteDataSource = async (id: string) => {
  const [deleted] = await db.delete(dataSource).where(eq(dataSource.id, id)).returning();

  if (!deleted) {
    throw new Error("Data source not found");
  }

  await fs.rm(resolveDataSourcePath(deleted.path), {
    force: true,
    recursive: true,
  });

  return [deleted];
};

export const discoverDataSource = async (id: string): Promise<DataSourceDiscoveryResult> => {
  const [source] = await db.select().from(dataSource).where(eq(dataSource.id, id));

  if (!source) {
    throw new Error("Data source not found");
  }

  const repoPath = resolveDataSourcePath(source.path);
  await getRepo({ repoPath, repoUrl: source.url });

  const discovery = await discoverComposeFiles(repoPath);
  const name = repositoryName(source.url);

  if (discovery.files.length === 0) {
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

  const [foundWorkspace] = await db
    .select()
    .from(workspace)
    .where(and(eq(workspace.dataSourceId, source.id), eq(workspace.name, name)))
    .limit(1);

  let targetWorkspace = foundWorkspace;

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
      .values({ dataSourceId: source.id, name, slug })
      .returning();

    if (!createdWorkspace) {
      throw new Error("Unable to create discovery workspace");
    }

    targetWorkspace = createdWorkspace;
    await createDataSourceFolder(repoPath, targetWorkspace.slug);
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

    await createDataSourceFolder(repoPath, targetWorkspace.slug, createdService.slug ?? slug);
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
