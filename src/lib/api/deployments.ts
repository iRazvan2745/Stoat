// oxlint-disable func-style no-await-in-loop no-use-before-define
import fs from "node:fs/promises";
import path from "node:path";

import { DATABASE_URL } from "$app/env/private";
import { eq, sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import * as v from "valibot";
import YAML, { isMap, isScalar } from "yaml";

import {
  dataSource,
  deploymentLogs,
  deployments,
  services,
  workspace,
} from "#lib/server/db/schema";
import { getRepo } from "#lib/server/git";
import { getService } from "#lib/server/services";

import { db } from "../server/db";

const StartDeploymentInput = v.object({
  service_id: v.string(),
});

const DEPLOYMENT_QUEUE = "deployments";

interface DeploymentJob {
  deployment_id: string;
  service_id: string;
}

const boss = new PgBoss(DATABASE_URL);
boss.on("error", (error) => {
  console.error("pg-boss error", error);
});

const { hot } = import.meta as { hot?: { dispose: (fn: () => void) => void } };
hot?.dispose(() => {
  void boss.stop();
});

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

async function processDeployment({
  deployment_id: deploymentId,
  service_id: serviceId,
}: DeploymentJob): Promise<void> {
  const startedMessage = `Deployment started for service ${serviceId}`;

  console.log(startedMessage);
  await db.transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({ startedAt: new Date() })
      .where(eq(deployments.id, deploymentId));
    await tx.insert(deploymentLogs).values({
      deploymentId,
      message: startedMessage,
      stream: "stdout",
    });
  });

  try {
    await prepareDeployment(serviceId, deploymentId);

    const svc = await getService(serviceId);

    const finishedMessage = `Deployment completed for service ${svc?.slug}`;
    await db.transaction(async (tx) => {
      await tx
        .update(deployments)
        .set({ finishedAt: new Date() })
        .where(eq(deployments.id, deploymentId));
      await tx.insert(deploymentLogs).values({
        deploymentId,
        message: finishedMessage,
        stream: "stdout",
      });
    });
    console.log(finishedMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Deployment failed for service ${serviceId}`, error);
    await addDeploymentLog(deploymentId, "stderr", message);
    throw error;
  }
}

let bossReady: Promise<void> | undefined;

async function initializeBoss(): Promise<void> {
  console.log("Starting pg-boss deployment worker");
  await boss.start();
  await boss.createQueue(DEPLOYMENT_QUEUE);
  const workerId = await boss.work<DeploymentJob>(DEPLOYMENT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await processDeployment(job.data);
    }
  });
  console.log("pg-boss deployment worker started", { workerId });
}

async function ensureBossReady(): Promise<void> {
  const ready = (bossReady ??= initializeBoss());

  try {
    await ready;
  } catch (error) {
    if (bossReady === ready) {
      bossReady = undefined;
    }
    console.error("Unable to start pg-boss deployment worker", error);
    throw error;
  }
}

export async function startDeployment({ service_id }: v.InferOutput<typeof StartDeploymentInput>) {
  await ensureBossReady();

  return db.transaction(async (tx) => {
    const [deployment] = await tx
      .insert(deployments)
      .values({ queuedAt: new Date(), serviceId: service_id })
      .returning({ id: deployments.id });

    if (!deployment) {
      throw new Error("Unable to create deployment");
    }

    const jobId = await boss.send(
      DEPLOYMENT_QUEUE,
      { deployment_id: deployment.id, service_id },
      { db: fromDrizzle(tx, sql) },
    );

    if (!jobId) {
      throw new Error("Unable to enqueue deployment");
    }

    await tx.insert(deploymentLogs).values({
      deploymentId: deployment.id,
      message: `Deployment queued for service ${service_id}`,
      stream: "stdout",
    });

    return { deploymentId: deployment.id, jobId };
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

async function prepareDeployment(id: string, deploymentId: string): Promise<void> {
  const log = (stream: "stdout" | "stderr", message: string) =>
    addDeploymentLog(deploymentId, stream, message);

  const [svc] = await db.select().from(services).where(eq(services.id, id));

  if (!svc?.value) {
    throw new Error("the compose is invalid");
  }

  const doc = YAML.parseDocument(svc.value);

  if (doc.errors.length > 0) {
    throw new Error(`Invalid compose YAML`);
  }

  const serviceMap = doc.get("services", true);

  if (!isMap(serviceMap)) {
    throw new Error('Compose must contain a "services" map');
  }

  const serviceSlug = svc.slug ?? svc.id;

  for (const pair of serviceMap.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error("Invalid service name");
    }

    pair.key.value = `${serviceSlug}-${pair.key.value}`;
  }

  const compose = doc.toString();
  const wrk = await getWorkspace(svc.workspaceId);
  const ds = await getDatasourceFromWorkspace(svc.workspaceId);
  const repoPath = path.resolve(ds.path);
  const servicePath = path.join(wrk.id, serviceSlug);
  const dataServiceDir = path.join(repoPath, servicePath);
  const repo = await getRepo({ repoPath, repoUrl: ds.url });

  await log("stdout", `Preparing deployment for service ${svc.name} (${serviceSlug})`);
  await log("stdout", `Parsed compose file with ${serviceMap.items.length} services`);

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
}

export async function deployService(id: string) {
  return await startDeployment({ service_id: id });
}
