// oxlint-disable no-await-in-loop
import { setTimeout as wait } from "node:timers/promises";

import { command, query } from "$app/server";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import * as v from "valibot";

import { requireDeploymentAccess, requireServiceAccess } from "#lib/api/guard";
import { withRemoteLiveLogging, withRemoteLogging } from "#lib/api/remote-logging";
import { db } from "#lib/db";
import { deploymentLogs, deployments } from "#lib/db/schema";
import {
    reconcileFailedDeployments,
    cancelDeployment as runCancelDeployment,
    deleteDeployment as runDeleteDeployment,
} from "#lib/server/deployments/deployments";

const DEPLOYMENT_POLL_INTERVAL = 1000;
const ServiceIdInput = v.string();
const DeploymentIdInput = v.string();

const streamDeployments = async function* streamDeployments(serviceId: string) {
    await requireServiceAccess(serviceId);

    let previousSnapshot: string | undefined;

    while (true) {
        await reconcileFailedDeployments(serviceId);

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

const readDeploymentLogs = async function* readDeploymentLogs(deploymentId: string) {
    await requireDeploymentAccess(deploymentId);

    const logs: (typeof deploymentLogs.$inferSelect)[] = [];
    let lastId = 0;
    let emitted = false;

    while (true) {
        // Only fetch rows we haven't seen yet instead of re-reading the whole log.
        const newLogs = await db
            .select()
            .from(deploymentLogs)
            .where(
                and(eq(deploymentLogs.deploymentId, deploymentId), gt(deploymentLogs.id, lastId)),
            )
            .orderBy(asc(deploymentLogs.id));

        if (newLogs.length > 0 || !emitted) {
            logs.push(...newLogs);
            lastId = logs.at(-1)?.id ?? lastId;
            emitted = true;
            yield [...logs];
        }

        await wait(DEPLOYMENT_POLL_INTERVAL);
    }
};

// Queries
export const getLatestSuccessfulDeployment = query(
    ServiceIdInput,
    withRemoteLogging(
        "deployments.getLatestSuccessfulDeployment",
        "query",
        async (serviceId: string) => {
            await requireServiceAccess(serviceId);

            const [deployment] = await db
                .select()
                .from(deployments)
                .where(
                    and(eq(deployments.serviceId, serviceId), eq(deployments.outcome, "success")),
                )
                .orderBy(desc(deployments.finishedAt), desc(deployments.id))
                .limit(1);

            return deployment ?? null;
        },
        { inputKey: "serviceId" },
    ),
);

// Live queries
export const listDeployments = query.live(
    ServiceIdInput,
    withRemoteLiveLogging("deployments.listDeployments", streamDeployments, {
        inputKey: "serviceId",
    }),
);

export const streamDeploymentLogs = query.live(
    DeploymentIdInput,
    withRemoteLiveLogging("deployments.streamDeploymentLogs", readDeploymentLogs, {
        inputKey: "deploymentId",
    }),
);

// Commands
export const cancelDeployment = command(
    DeploymentIdInput,
    withRemoteLogging(
        "deployments.cancelDeployment",
        "command",
        async (deploymentId: string) => {
            await requireDeploymentAccess(deploymentId);
            await runCancelDeployment(deploymentId);
        },
        { inputKey: "deploymentId" },
    ),
);

export const deleteDeployment = command(
    DeploymentIdInput,
    withRemoteLogging(
        "deployments.deleteDeployment",
        "command",
        async (deploymentId: string) => {
            await requireDeploymentAccess(deploymentId);
            await runDeleteDeployment(deploymentId);
        },
        { inputKey: "deploymentId" },
    ),
);
