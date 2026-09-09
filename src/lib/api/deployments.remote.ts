// oxlint-disable no-await-in-loop
import { setTimeout as wait } from "node:timers/promises";

import { command, getRequestEvent, query } from "$app/server";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import * as v from "valibot";

import { requireDeploymentAccess, requireResourceAccess } from "#lib/api/guard";
import { withRemoteLiveLogging, withRemoteLogging } from "#lib/api/remote-logging";
import { db } from "#lib/db";
import { deploymentLogs, deployments } from "#lib/db/schema";
import {
    cancelDeployment as runCancelDeployment,
    deleteDeployment as runDeleteDeployment,
} from "#lib/server/deployments/deployments";
import {
    createDeploymentLogBatch,
    DEPLOYMENT_LOG_BATCH_SIZE,
} from "#lib/server/deployments/log-stream";

const DEPLOYMENT_POLL_INTERVAL = 1000;
const NonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));
const ResourceIdInput = v.string();
const DeploymentIdInput = v.string();
const DeploymentLogBatchInput = v.object({
    afterId: NonNegativeInteger,
    deploymentId: v.string(),
});

const streamDeployments = async function* streamDeployments(resourceId: string) {
    await requireResourceAccess(resourceId);
    const { request } = getRequestEvent();
    const { signal } = request;

    let previousSnapshot: string | undefined;

    while (!signal.aborted) {
        const currentDeployments = await db
            .select()
            .from(deployments)
            .where(eq(deployments.resourceId, resourceId))
            .orderBy(desc(deployments.createdAt), desc(deployments.id));
        const currentSnapshot = JSON.stringify(currentDeployments);

        if (currentSnapshot !== previousSnapshot) {
            previousSnapshot = currentSnapshot;
            yield currentDeployments;
        }

        try {
            await wait(DEPLOYMENT_POLL_INTERVAL, undefined, { signal });
        } catch (error) {
            if (signal.aborted) {
                return;
            }

            throw error;
        }
    }
};

const fetchDeploymentLogBatch = async ({
    afterId,
    deploymentId,
}: v.InferOutput<typeof DeploymentLogBatchInput>) => {
    await requireDeploymentAccess(deploymentId);

    // Read terminal state before logs. Completion and its final log are written
    // in one transaction, so a terminal read always sees a drainable history.
    const [deployment] = await db
        .select({ finishedAt: deployments.finishedAt })
        .from(deployments)
        .where(eq(deployments.id, deploymentId));
    const terminal = !deployment || deployment.finishedAt !== null;
    const logs = await db
        .select()
        .from(deploymentLogs)
        .where(and(eq(deploymentLogs.deploymentId, deploymentId), gt(deploymentLogs.id, afterId)))
        .orderBy(asc(deploymentLogs.id))
        .limit(DEPLOYMENT_LOG_BATCH_SIZE);

    return createDeploymentLogBatch(logs, afterId, terminal);
};

// Queries
export const getLatestSuccessfulDeployment = query(
    ResourceIdInput,
    withRemoteLogging(
        "deployments.getLatestSuccessfulDeployment",
        "query",
        async (resourceId: string) => {
            await requireResourceAccess(resourceId);

            const [deployment] = await db
                .select()
                .from(deployments)
                .where(
                    and(eq(deployments.resourceId, resourceId), eq(deployments.outcome, "success")),
                )
                .orderBy(desc(deployments.finishedAt), desc(deployments.id))
                .limit(1);

            return deployment ?? null;
        },
        { inputKey: "resourceId" },
    ),
);

export const getDeploymentLogBatch = query(
    DeploymentLogBatchInput,
    withRemoteLogging("deployments.getDeploymentLogBatch", "query", fetchDeploymentLogBatch, {
        inputKey: "deploymentId",
    }),
);

// Live queries
export const listDeployments = query.live(
    ResourceIdInput,
    withRemoteLiveLogging("deployments.listDeployments", streamDeployments, {
        inputKey: "resourceId",
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
