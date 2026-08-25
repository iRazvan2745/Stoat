import fs from "node:fs/promises";

import { eq, inArray } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, environmentVariables, services, workspace } from "#lib/db/schema";
import { createWorkspaceFolder, workspacePath } from "#lib/server/data-source/paths";
import { getRepo } from "#lib/server/shared/git";
import { uniqueSlug } from "#lib/server/shared/slugs";

export const listWorkspaces = async () => {
  const workspaces = await db.select().from(workspace).orderBy(workspace.createdAt);

  return workspaces.toReversed();
};

export const getWorkspace = async (id: string) => {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));

  return wrk;
};

export const createWorkspace = async ({
  dataSourceId,
  name,
}: {
  dataSourceId: string;
  name: string;
}) => {
  const [source] = await db.select().from(dataSource).where(eq(dataSource.id, dataSourceId));

  if (!source) {
    throw new Error("Data source not found");
  }

  const slug = await uniqueSlug(name, async (candidate) => {
    const matches = await db
      .select({ slug: workspace.slug })
      .from(workspace)
      .where(eq(workspace.slug, candidate));

    return matches.length > 0;
  });

  const [created] = await db.insert(workspace).values({ dataSourceId, name, slug }).returning();

  if (!created) {
    throw new Error("Unable to create workspace");
  }

  const repoPath = workspacePath(created.id);

  try {
    await getRepo({ repoPath, repoUrl: source.url });
    await createWorkspaceFolder(repoPath, created.slug);
  } catch (error) {
    await db.delete(workspace).where(eq(workspace.id, created.id));
    await fs.rm(repoPath, { force: true, recursive: true });
    throw error;
  }

  return created;
};

export const deleteWorkspace = async (id: string) => {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));

  if (!wrk) {
    throw new Error("Workspace not found");
  }

  const deleted = await db.transaction(async (tx) => {
    // environment_variables.service_id is onDelete: "restrict", so the
    // services rows cannot be deleted while variables still reference them.
    const workspaceServices = tx
      .select({ id: services.id })
      .from(services)
      .where(eq(services.workspaceId, id));
    await tx
      .delete(environmentVariables)
      .where(inArray(environmentVariables.serviceId, workspaceServices));
    await tx.delete(services).where(eq(services.workspaceId, id));

    return await tx.delete(workspace).where(eq(workspace.id, id)).returning();
  });

  await fs.rm(workspacePath(id), {
    force: true,
    recursive: true,
  });

  return deleted;
};
