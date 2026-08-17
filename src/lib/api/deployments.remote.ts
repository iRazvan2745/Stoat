// oxlint-disable no-await-in-loop
import { setTimeout as wait } from "node:timers/promises";

import { query } from "$app/server";
import { asc, desc, eq } from "drizzle-orm";
import * as v from "valibot";

import { deploymentLogs, deployments } from "#lib/server/db/schema";

import { db } from "../server/db";

const DEPLOYMENT_POLL_INTERVAL = 1000;

const streamDeployments = async function* streamDeployments(serviceId: string) {
  let previousSnapshot: string | undefined;

  while (true) {
    const currentDeployments = await db
      .select()
      .from(deployments)
      .where(eq(deployments.serviceId, serviceId))
      .orderBy(desc(deployments.createdAt), desc(deployments.id));
    const currentSnapshot = JSON.stringify(currentDeployments);

    if (currentSnapshot !== previousSnapshot) {
      previousSnapshot = currentSnapshot;
      yield currentDeployments;
    }

    await wait(DEPLOYMENT_POLL_INTERVAL);
  }
};

export const getDeployments = query.live(v.string(), streamDeployments);

const streamDeploymentLogs = async function* streamDeploymentLogs(deploymentId: string) {
  let previousSnapshot: string | undefined;

  while (true) {
    const currentLogs = await db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, deploymentId))
      .orderBy(asc(deploymentLogs.id));
    const currentSnapshot = JSON.stringify(currentLogs);

    if (currentSnapshot !== previousSnapshot) {
      previousSnapshot = currentSnapshot;
      yield currentLogs;
    }

    await wait(DEPLOYMENT_POLL_INTERVAL);
  }
};

export const getDeploymentLogs = query.live(v.string(), streamDeploymentLogs);
