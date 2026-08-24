// oxlint-disable func-style no-await-in-loop
import { DATABASE_URL } from "$app/env/private";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import * as v from "valibot";

import { db } from "#lib/db";
import { deploymentLogs, deployments } from "#lib/db/schema";
import { detectDeploymentFailure } from "#lib/deployments/failure";
import { prepareDeployment } from "#lib/server/deployments/deployment-prepare";
import { getService } from "#lib/server/service/services";
import { parseServiceSettings } from "#lib/service/settings";

const StartDeploymentInput = v.object({
  service_id: v.string(),
});

const DEPLOYMENT_QUEUE = "deployments";

const STALE_DEPLOYMENT_TIMEOUT_MS = 10 * 60 * 1000;
const RECONCILE_MIN_INTERVAL_MS = 10_000;

interface DeploymentJob {
  deployment_id: string;
  service_id: string;
}

/** Abort controllers for deployments currently being processed in this instance. */
const activeDeployments = new Map<string, AbortController>();

const boss = new PgBoss(DATABASE_URL);
boss.on("error", (error) => {
  console.error("pg-boss error", error);
});

const { hot } = import.meta as { hot?: { dispose: (fn: () => void) => void } };
hot?.dispose(() => {
  void boss.stop();
});

async function getDeploymentRecord(deploymentId: string) {
  const [deployment] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));

  return deployment;
}

async function isDeploymentTerminal(deploymentId: string): Promise<boolean> {
  const deployment = await getDeploymentRecord(deploymentId);

  return Boolean(deployment?.finishedAt);
}

async function processDeployment({
  deployment_id: deploymentId,
  service_id: serviceId,
}: DeploymentJob): Promise<void> {
  const existing = await getDeploymentRecord(deploymentId);

  if (!existing || existing.outcome === "cancelled" || existing.finishedAt) {
    return;
  }

  const startedMessage = `Deployment started for service ${serviceId}`;

  console.log(startedMessage);
  const svc = await getService(serviceId);
  await db.transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({
        settings: parseServiceSettings(svc?.settings),
        startedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
    await tx.insert(deploymentLogs).values({
      deploymentId,
      message: startedMessage,
      stream: "debug",
    });
  });

  const controller = new AbortController();
  activeDeployments.set(deploymentId, controller);

  try {
    await prepareDeployment(serviceId, deploymentId, controller.signal);

    if (await isDeploymentTerminal(deploymentId)) {
      return;
    }

    const finishedMessage = `Deployment completed for service ${svc?.slug}`;
    await db.transaction(async (tx) => {
      await tx
        .update(deployments)
        .set({ finishedAt: new Date(), outcome: "success" })
        .where(eq(deployments.id, deploymentId));
      await tx.insert(deploymentLogs).values({
        deploymentId,
        message: finishedMessage,
        stream: "debug",
      });
    });
    console.log(finishedMessage);
  } catch (error) {
    if (await isDeploymentTerminal(deploymentId)) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`Deployment failed for service ${serviceId}`, error);
    await db.transaction(async (tx) => {
      await tx
        .update(deployments)
        .set({ finishedAt: new Date(), outcome: "failed" })
        .where(eq(deployments.id, deploymentId));
      await tx.insert(deploymentLogs).values({
        deploymentId,
        message,
        stream: "stderr",
      });
    });
  } finally {
    activeDeployments.delete(deploymentId);
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

export async function ensureDeploymentWorker(): Promise<void> {
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
  await ensureDeploymentWorker();

  return db.transaction(async (tx) => {
    const [deployment] = await tx
      .insert(deployments)
      .values({ queuedAt: new Date(), serviceId: service_id })
      .returning({ id: deployments.id });

    if (!deployment) {
      throw new Error("Unable to create deployment");
    }

    // singletonKey allows at most one queued (not yet started) job per service.
    const jobId = await boss.send(
      DEPLOYMENT_QUEUE,
      { deployment_id: deployment.id, service_id },
      {
        db: fromDrizzle(tx, sql),
        retryLimit: 0,
        singletonKey: service_id,
      },
    );

    if (!jobId) {
      throw new Error("A deployment is already queued for this service");
    }

    await tx.update(deployments).set({ jobId }).where(eq(deployments.id, deployment.id));

    await tx.insert(deploymentLogs).values({
      deploymentId: deployment.id,
      message: `Deployment queued for service ${service_id}`,
      stream: "debug",
    });

    return { deploymentId: deployment.id, jobId };
  });
}

export async function deployService(id: string) {
  return await startDeployment({ service_id: id });
}

export async function cancelDeployment(deploymentId: string): Promise<void> {
  await ensureDeploymentWorker();

  const deployment = await getDeploymentRecord(deploymentId);

  if (!deployment) {
    throw new Error("Deployment not found");
  }

  if (deployment.finishedAt) {
    throw new Error("Deployment is already finished");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({ finishedAt: new Date(), outcome: "cancelled" })
      .where(eq(deployments.id, deploymentId));
    await tx.insert(deploymentLogs).values({
      deploymentId,
      message: "Deployment force cancelled",
      stream: "stderr",
    });
  });

  // Abort in-flight work (git push / deploy stream) after the record is
  // marked cancelled, so the worker sees the terminal state and stops quietly.
  activeDeployments.get(deploymentId)?.abort();

  if (deployment.jobId) {
    try {
      await boss.cancel(DEPLOYMENT_QUEUE, deployment.jobId);
    } catch (error) {
      console.warn("Unable to cancel deployment job", {
        deploymentId,
        error,
      });
    }
  }
}

export async function deleteDeployment(deploymentId: string): Promise<void> {
  const deployment = await getDeploymentRecord(deploymentId);

  if (!deployment) {
    throw new Error("Deployment not found");
  }

  if (!deployment.finishedAt) {
    throw new Error("Deployment is still running — cancel it before deleting");
  }

  await db.delete(deployments).where(eq(deployments.id, deploymentId));
}

async function markDeploymentFailed(deploymentId: string, reason?: string): Promise<void> {
  const updated = await db
    .update(deployments)
    .set({ finishedAt: new Date(), outcome: "failed" })
    .where(and(eq(deployments.id, deploymentId), isNull(deployments.finishedAt)))
    .returning({ id: deployments.id });

  if (updated.length > 0 && reason) {
    await db.insert(deploymentLogs).values({
      deploymentId,
      message: reason,
      stream: "stderr",
    });
  }
}

const reconcileLastRunAt = new Map<string, number>();

export async function reconcileFailedDeployments(serviceId: string): Promise<void> {
  const now = Date.now();
  const lastRun = reconcileLastRunAt.get(serviceId);

  if (lastRun !== undefined && now - lastRun < RECONCILE_MIN_INTERVAL_MS) {
    return;
  }

  reconcileLastRunAt.set(serviceId, now);

  const unfinished = await db
    .select({
      createdAt: deployments.createdAt,
      id: deployments.id,
      queuedAt: deployments.queuedAt,
      startedAt: deployments.startedAt,
    })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), isNull(deployments.finishedAt)));

  if (unfinished.length === 0) {
    return;
  }

  const logs = await db
    .select({
      createdAt: deploymentLogs.createdAt,
      deploymentId: deploymentLogs.deploymentId,
      message: deploymentLogs.message,
    })
    .from(deploymentLogs)
    .where(
      inArray(
        deploymentLogs.deploymentId,
        unfinished.map((deployment) => deployment.id),
      ),
    );

  const logsByDeployment = new Map<string, { createdAt: Date; message: string }[]>();

  for (const log of logs) {
    const current = logsByDeployment.get(log.deploymentId) ?? [];
    current.push({ createdAt: log.createdAt, message: log.message });
    logsByDeployment.set(log.deploymentId, current);
  }

  for (const deployment of unfinished) {
    const deploymentLogEntries = logsByDeployment.get(deployment.id) ?? [];
    const failure = detectDeploymentFailure(deploymentLogEntries);

    if (failure) {
      await markDeploymentFailed(deployment.id);
      continue;
    }

    // Recover deployments orphaned by a crash or restart: no terminal state
    // and no activity (new logs) for longer than the stale timeout.
    let lastActivity = Math.max(
      deployment.createdAt.getTime(),
      deployment.queuedAt?.getTime() ?? 0,
      deployment.startedAt?.getTime() ?? 0,
    );

    for (const log of deploymentLogEntries) {
      lastActivity = Math.max(lastActivity, log.createdAt.getTime());
    }

    if (now - lastActivity > STALE_DEPLOYMENT_TIMEOUT_MS) {
      await markDeploymentFailed(
        deployment.id,
        "Deployment marked as failed after 10 minutes without activity",
      );
    }
  }
}
