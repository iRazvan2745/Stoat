// oxlint-disable func-style no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { dataSource, deploymentLogs, workspace } from "#lib/db/schema";
import { serializeEnvFile } from "#lib/environment";
import { workspacePath } from "#lib/server/data-source/paths";
import {
  formatComposeFile,
  inlineEnvironmentVariables,
} from "#lib/server/deployments/deployment-compose";
import { consumeDeployStream } from "#lib/server/deployments/deployment-stream";
import { listEnvironmentVariables } from "#lib/server/service/service-environment";
import { getService, serviceComposePrefix } from "#lib/server/service/services";
import { getRepo } from "#lib/server/shared/git";
import { withKeyedLock } from "#lib/server/shared/locks";
import { ucStreamClient } from "#lib/server/uncloud";

import { db } from "../../db";

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

const ensureEnvIgnored = async (serviceDir: string): Promise<void> => {
  const gitignorePath = path.join(serviceDir, ".gitignore");
  let existing = "";

  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    existing = "";
  }

  if (existing.split("\n").some((line) => line.trim() === ".env")) {
    return;
  }

  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  await fs.writeFile(gitignorePath, `${prefix}.env\n`, "utf-8");
};

export async function prepareDeployment(
  id: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const log = (stream: "debug" | "stderr" | "stdout", message: string) =>
    addDeploymentLog(deploymentId, stream, message);
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new Error("Deployment cancelled");
    }
  };

  const svc = await getService(id);

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  const serviceSlug = svc.slug ?? svc.id;
  const formatted = formatComposeFile(svc.value, serviceComposePrefix(svc));
  const environment = await listEnvironmentVariables(id);
  const deployCompose = inlineEnvironmentVariables(formatted.yaml, environment);
  const wrk = await getWorkspace(svc.workspaceId);
  const ds = await getDatasourceFromWorkspace(svc.workspaceId);
  const repoPath = workspacePath(wrk.id);
  const servicePath = path.join(wrk.slug, serviceSlug);
  const dataServiceDir = path.join(repoPath, servicePath);

  await log("stdout", `Preparing deployment for service ${svc.name} (${serviceSlug})`);
  await log("debug", `Parsed compose file with ${formatted.serviceCount} services`);

  if (environment.length > 0) {
    await log("debug", `Applied ${environment.length} environment variables`);
  }

  throwIfCancelled();

  // Serialize git work per workspace: services in the same workspace share
  // one checkout, so concurrent deploys must not interleave pull/commit/push.
  await withKeyedLock(`workspace-git:${wrk.id}`, async () => {
    const repo = await getRepo({ repoPath, repoUrl: ds.url });

    await fs.mkdir(dataServiceDir, { recursive: true });
    const dataComposePath = path.join(dataServiceDir, "compose.yaml");
    const dataEnvPath = path.join(dataServiceDir, ".env");
    // Commit the raw (non-interpolated) compose so secret values never enter
    // git history; the deploy payload sent to uncloud is built separately.
    await fs.writeFile(dataComposePath, formatted.yaml, "utf-8");
    await log("debug", `Wrote compose file to ${dataComposePath}`);

    if (environment.length > 0) {
      await fs.writeFile(dataEnvPath, serializeEnvFile(environment), "utf-8");
      await log("debug", `Wrote environment file to ${dataEnvPath} (kept out of git)`);
    } else {
      await fs.rm(dataEnvPath, { force: true });
    }

    await ensureEnvIgnored(dataServiceDir);

    throwIfCancelled();

    const composeRepoPath = path.join(servicePath, "compose.yaml");
    const gitignoreRepoPath = path.join(servicePath, ".gitignore");
    const envRepoPath = path.join(servicePath, ".env");

    // Drop a .env committed by earlier versions from the index (not the
    // working tree) so it stops being tracked and pushed.
    const trackedEnv = await repo.raw(["ls-files", "--", envRepoPath]);
    const envWasTracked = trackedEnv.trim() !== "";
    if (envWasTracked) {
      await repo.raw(["rm", "--cached", "--quiet", "--", envRepoPath]);
      await log("debug", `Removed ${envRepoPath} from git tracking`);
    }

    await log("debug", `Checking git status in ${repoPath}`);

    const status = await repo.status();
    const changedFiles = status.files.filter(
      (file) => file.path === composeRepoPath || file.path === gitignoreRepoPath,
    );
    if (changedFiles.length > 0 || envWasTracked) {
      const addPaths = changedFiles.map((file) => file.path);

      if (addPaths.length > 0) {
        const fileList = addPaths.map((filePath) => `  ${filePath}`).join("\n");
        await log("debug", `Changes detected:\n${fileList}`);

        await repo.add(addPaths);
        await log("debug", `Added ${addPaths.join(", ")} to git index`);
      }

      const commit = await repo.commit(
        `Committing new changes on Service ${svc.name} before deploying`,
      );
      await log("debug", `Committed changes: ${commit.commit}`);
      await log(
        "debug",
        `Changes: ${commit.summary.changes}, insertions: ${commit.summary.insertions}, deletions: ${commit.summary.deletions}`,
      );
      await log("stdout", "Saved compose changes to git");
    } else {
      await log("debug", "No changes to commit — compose file is already up to date");
      await log("stdout", "Compose file is already up to date");
    }

    await log("debug", "Pushing changes to git remote");
    const push = await repo.push();
    if (push.pushed.length > 0) {
      for (const detail of push.pushed) {
        await log("debug", `  Pushed ${detail.local} -> ${detail.remote}`);
      }
      await log("stdout", "Pushed configuration to git remote");
    } else {
      await log("debug", "Nothing to push — remote is already up to date");
    }
  });

  throwIfCancelled();

  const deploy = await ucStreamClient.POST("/api/v1/services/deploy/compose", {
    body: {
      compose: Buffer.from(deployCompose).toString("base64"),
      options: {
        //profiles: [""],
        //recreate: true,
        //skipHealth: true,
      },
    },
    parseAs: "stream",
    signal,
  });

  if (deploy.error) {
    // The schema declares no error body for this endpoint, so widen the type
    // to surface whatever uncloud actually returned.
    const errorBody: unknown = deploy.error;
    const detail = typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody);
    const httpStatus = deploy.response ? ` (HTTP ${deploy.response.status})` : "";
    throw new Error(`Failed to deploy service${httpStatus}: ${detail}`);
  }

  if (!deploy.response) {
    throw new Error("Deploy request did not return a response");
  }

  await consumeDeployStream(deploy.response, log);
  await log("stdout", `Deployed service ${svc.name} (${serviceSlug})`);
}
