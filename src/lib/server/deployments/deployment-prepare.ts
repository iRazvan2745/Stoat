// oxlint-disable func-style no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { ucClient } from "#lib/api/client";
import { resolveDataSourcePath } from "#lib/server/data-source";
import { dataSource, deploymentLogs, workspace } from "#lib/server/db/schema";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import { consumeDeployStream } from "#lib/server/deployments/deployment-stream";
import { getRepo } from "#lib/server/git";
import { getService } from "#lib/server/service/services";

import { db } from "../db";

async function addDeploymentLog(
  deploymentId: string,
  stream: string,
  message: string,
): Promise<void> {
  await db.insert(deploymentLogs).values({
    deploymentId,
    message,
    stream,
  });
}

async function getDatasourceFromWorkspace(id: string) {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));
  if (!wrk) {
    throw new Error("workspace not found");
  }

  const [ds] = await db.select().from(dataSource).where(eq(dataSource.id, wrk.dataSourceId));

  if (!ds) {
    throw new Error("data source not found");
  }

  return ds;
}

async function getWorkspace(id: string) {
  const [wrk] = await db.select().from(workspace).where(eq(workspace.id, id));
  if (!wrk) {
    throw new Error("workspace not found");
  }

  return wrk;
}

export async function prepareDeployment(id: string, deploymentId: string): Promise<void> {
  const log = (stream: "stdout" | "stderr", message: string) =>
    addDeploymentLog(deploymentId, stream, message);

  const svc = await getService(id);

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  const serviceSlug = svc.slug ?? svc.id;
  const formatted = formatComposeFile(svc.value, serviceSlug);
  const compose = formatted.yaml;
  const wrk = await getWorkspace(svc.workspaceId);
  const ds = await getDatasourceFromWorkspace(svc.workspaceId);
  const repoPath = resolveDataSourcePath(ds.path);
  const servicePath = path.join(wrk.id, serviceSlug);
  const dataServiceDir = path.join(repoPath, servicePath);
  const repo = await getRepo({ repoPath, repoUrl: ds.url });

  await log("stdout", `Preparing deployment for service ${svc.name} (${serviceSlug})`);
  await log("stdout", `Parsed compose file with ${formatted.serviceCount} services`);

  await fs.mkdir(dataServiceDir, { recursive: true });
  const dataComposePath = path.join(dataServiceDir, "compose.yaml");
  await fs.writeFile(dataComposePath, compose, "utf-8");
  await log("stdout", `Wrote compose file to ${dataComposePath}`);

  const composeRepoPath = path.join(servicePath, "compose.yaml");
  await log("stdout", `Checking git status in ${repoPath}`);

  const status = await repo.status();
  const changedFiles = status.files.filter((file) => file.path === composeRepoPath);
  if (changedFiles.length > 0) {
    const fileList = changedFiles.map((file) => `  ${file.path}`).join("\n");
    await log("stdout", `Changes detected:\n${fileList}`);

    await repo.add(composeRepoPath);
    await log("stdout", `Added ${composeRepoPath} to git index`);

    const commit = await repo.commit(
      `Committing new changes on Service ${svc.name} before deploying`,
    );
    await log("stdout", `Committed changes: ${commit.commit}`);
    await log(
      "stdout",
      `Changes: ${commit.summary.changes}, insertions: ${commit.summary.insertions}, deletions: ${commit.summary.deletions}`,
    );
  } else {
    await log("stdout", "No changes to commit — compose file is already up to date");
  }

  await log("stdout", `Pushing changes to ${ds.url}`);
  const push = await repo.push();
  if (push.pushed.length > 0) {
    for (const detail of push.pushed) {
      await log("stdout", `  Pushed ${detail.local} -> ${detail.remote}`);
    }
  } else {
    await log("stdout", "Nothing to push — remote is already up to date");
  }

  const deploy = await ucClient.POST("/api/v1/services/deploy/compose", {
    body: {
      compose: Buffer.from(compose).toString("base64"),
      options: {
        //profiles: [""],
        //recreate: true,
        //skipHealth: true,
      },
    },
    parseAs: "stream",
  });

  if (deploy.error) {
    throw new Error("Failed to deploy service");
  }

  if (!deploy.response) {
    throw new Error("Deploy request did not return a response");
  }

  await consumeDeployStream(deploy.response, log);
  await log("stdout", `Deployed service ${svc.name} (${serviceSlug})`);
}
