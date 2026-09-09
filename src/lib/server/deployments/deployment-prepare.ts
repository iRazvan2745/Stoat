// oxlint-disable func-style no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { and, eq, isNull } from "drizzle-orm";

import { deploymentLogs, deployments } from "#lib/db/schema";
import { serializeEnvFile } from "#lib/domain/environment";
import { workspacePath } from "#lib/server/data-sources/paths";
import {
    formatComposeFile,
    inlineEnvironmentVariables,
} from "#lib/server/deployments/deployment-compose";
import { consumeDeployStream } from "#lib/server/deployments/deployment-stream";
import { resourceComposePrefix } from "#lib/server/resources/resources";
import { withGitRepo } from "#lib/server/shared/git";
import { gitAuthenticationFromSource } from "#lib/server/shared/git-auth";
import { withKeyedLock } from "#lib/server/shared/locks";
import { createUncloudStreamClient } from "#lib/server/uncloud";

import { db } from "../../db";
import type { DeploymentSnapshot } from "./deployment-snapshot";

async function addDeploymentLog(
    deploymentId: string,
    stream: string,
    message: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        // Serialize log writes with terminal transitions.  A cancellation can
        // race a log that was already in flight; locking the deployment row
        // makes the log either commit before the terminal record or get
        // discarded after it.
        const [deployment] = await tx
            .select({ id: deployments.id })
            .from(deployments)
            .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
            .for("update");
        if (!deployment) {
            return;
        }

        await tx.insert(deploymentLogs).values({
            deploymentId,
            message,
            stream,
        });
    });
}

const ensureEnvIgnored = async (resourceDir: string): Promise<void> => {
    const gitignorePath = path.join(resourceDir, ".gitignore");
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
    snapshot: DeploymentSnapshot,
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

    const { environment, git, resource, source, workspace: wrk } = snapshot;

    if (!resource?.value) {
        throw new Error("the compose is invalid");
    }

    if (snapshot.gitValidationError) throw new Error(snapshot.gitValidationError);
    const resourceSlug = resource.slug ?? resource.id;
    const formatted = formatComposeFile(
        snapshot.gitCompose ?? resource.value,
        snapshot.gitCompose === undefined ? resourceComposePrefix(resource) : undefined,
    );
    const deployCompose = inlineEnvironmentVariables(formatted.yaml, environment);
    const repoPath = workspacePath(wrk.id);
    const resourcePath = path.join(wrk.slug, resourceSlug);
    const dataResourceDir = path.join(repoPath, resourcePath);

    await log("stdout", `Preparing deployment for resource ${resource.name} (${resourceSlug})`);
    await log("debug", `Parsed compose file with ${formatted.serviceCount} services`);

    if (environment.length > 0) {
        await log("debug", `Applied ${environment.length} environment variables`);
    }

    throwIfCancelled();

    // Serialize git work per workspace: resources in the same workspace share
    // one checkout, so concurrent deploys must not interleave pull/commit/push.
    const gitUrl = snapshot.gitCommit ? null : git.url;

    const gitSync = gitUrl
        ? withKeyedLock(
              `workspace-git:${wrk.id}`,
              async () =>
                  await withGitRepo(
                      {
                          authentication: gitAuthenticationFromSource(git),
                          repoPath,
                          repoUrl: gitUrl,
                      },
                      async (repo) => {
                          await fs.mkdir(dataResourceDir, { recursive: true });
                          const dataComposePath = path.join(dataResourceDir, "compose.yaml");
                          const dataEnvPath = path.join(dataResourceDir, ".env");
                          // Commit the raw (non-interpolated) compose so secret values never enter
                          // git history; the deploy payload sent to uncloud is built separately.
                          await fs.writeFile(dataComposePath, formatted.yaml, "utf-8");
                          await log("debug", `Wrote compose file to ${dataComposePath}`);

                          if (environment.length > 0) {
                              await fs.writeFile(
                                  dataEnvPath,
                                  serializeEnvFile(environment),
                                  "utf-8",
                              );
                              await log(
                                  "debug",
                                  `Wrote environment file to ${dataEnvPath} (kept out of git)`,
                              );
                          } else {
                              await fs.rm(dataEnvPath, { force: true });
                          }

                          await ensureEnvIgnored(dataResourceDir);

                          throwIfCancelled();

                          const composeRepoPath = path.join(resourcePath, "compose.yaml");
                          const gitignoreRepoPath = path.join(resourcePath, ".gitignore");
                          const envRepoPath = path.join(resourcePath, ".env");

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
                              (file) =>
                                  file.path === composeRepoPath || file.path === gitignoreRepoPath,
                          );
                          if (changedFiles.length > 0 || envWasTracked) {
                              const addPaths = changedFiles.map((file) => file.path);

                              if (addPaths.length > 0) {
                                  const fileList = addPaths
                                      .map((filePath) => `  ${filePath}`)
                                      .join("\n");
                                  await log("debug", `Changes detected:\n${fileList}`);

                                  await repo.add(addPaths);
                                  await log("debug", `Added ${addPaths.join(", ")} to git index`);
                              }

                              const commit = await repo.commit(
                                  `Committing new changes on Resource ${resource.name} before deploying`,
                              );
                              await log("debug", `Committed changes: ${commit.commit}`);
                              await log(
                                  "debug",
                                  `Changes: ${commit.summary.changes}, insertions: ${commit.summary.insertions}, deletions: ${commit.summary.deletions}`,
                              );
                              await log("stdout", "Saved compose changes to git");
                          } else {
                              await log(
                                  "debug",
                                  "No changes to commit — compose file is already up to date",
                              );
                              await log("stdout", "Compose file is already up to date");
                          }

                          await log("debug", "Pushing changes to git remote");
                          const push = await repo.push();
                          if (push.pushed.length > 0) {
                              for (const detail of push.pushed) {
                                  await log(
                                      "debug",
                                      `  Pushed ${detail.local} -> ${detail.remote}`,
                                  );
                              }
                              await log("stdout", "Pushed configuration to git remote");
                          } else {
                              await log("debug", "Nothing to push — remote is already up to date");
                          }
                      },
                  ),
          )
        : log("debug", "Data source has no Git URL — skipping git sync");
    await gitSync;

    throwIfCancelled();

    const deploy = await createUncloudStreamClient(source).POST("/api/v1/services/deploy/compose", {
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
        throw new Error(`Failed to deploy resource${httpStatus}: ${detail}`);
    }

    if (!deploy.response) {
        throw new Error("Deploy request did not return a response");
    }

    await consumeDeployStream(deploy.response, log);
    await log("stdout", `Deployed resource ${resource.name} (${resourceSlug})`);
}
