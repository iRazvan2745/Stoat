// oxlint-disable func-style no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { DATABASE_URL } from "$app/env/private";
import { eq, sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import * as v from "valibot";
import YAML, { isMap, isScalar } from "yaml";

import { getDataDir } from "#lib/server/data-source";
import {
  dataSource,
  deploymentLogs,
  deployments,
  services,
  workspace,
} from "#lib/server/db/schema";
import { getRepo } from "#lib/server/git";

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
    await prepareDeployment(serviceId);

    const finishedMessage = `Deployment completed for service ${serviceId}`;
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

async function prepareDeployment(id: string): Promise<void> {
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
  const dataWorkspacePath = path.resolve(getDataDir(), wrk.id);
  const repoPath = path.resolve(ds.path);
  const servicePath = path.join(wrk.slug, serviceSlug);
  const dataServiceDir = path.join(dataWorkspacePath, serviceSlug);
  const repoServiceDir = path.join(repoPath, servicePath);
  const repo = await getRepo({ repoPath, repoUrl: ds.url });

  await fs.mkdir(dataServiceDir, { recursive: true });
  await fs.writeFile(path.join(dataServiceDir, "compose.yaml"), compose, "utf-8");

  // A data source can use a separate checkout for git. Keep the generated
  // compose in DATA_DIR as the deployment artifact and mirror it there.
  if (repoPath !== dataWorkspacePath) {
    await fs.mkdir(repoServiceDir, { recursive: true });
    await fs.writeFile(path.join(repoServiceDir, "compose.yaml"), compose, "utf-8");
  }

  const composeRepoPath = path.join(servicePath, "compose.yaml");

  const status = await repo.status();
  const composeChanged = status.files.some((file) => file.path === composeRepoPath);
  if (composeChanged) {
    console.log("adding changes", {
      files: status.files.filter((file) => file.path === composeRepoPath),
    });
    await repo.add(composeRepoPath);
    console.log("committing changes");
    const commit = await repo.commit(
      `Committing new changes on Service ${svc.name} before deploying`,
    );
    console.log("committed changes", { commit: commit.commit });
  } else {
    console.log("no changes to commit");
  }

  console.log("pushing changes");
  const push = await repo.push();
  console.log("pushed changes", {
    pushed: push.pushed,
    update: push.update,
  });
}

export async function deployService(id: string) {
  return await startDeployment({ service_id: id });
}
