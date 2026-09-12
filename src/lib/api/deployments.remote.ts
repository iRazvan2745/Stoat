// oxlint-disable no-await-in-loop
import { setTimeout as wait } from "node:timers/promises";

import { command, getRequestEvent, query } from "$app/server";
import { error as kitError } from "@sveltejs/kit";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Stream } from "effect";
import * as v from "valibot";

import {
    requireDeploymentAccess,
    requireResourceAccess,
    requireSession,
} from "#lib/api/guard";
import {
    withRemoteLiveLogging,
    withRemoteLogging,
} from "#lib/api/remote-logging";
import { db } from "#lib/db";
import { deploymentLogs, deployments } from "#lib/db/schema";
import { getOrganizationIdForUser } from "#lib/server/access";
import {
    deploymentsStream,
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

const streamDeployments = async function* streamDeployments(
    resourceId: string
) {
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
        .where(
            and(
                eq(deploymentLogs.deploymentId, deploymentId),
                gt(deploymentLogs.id, afterId)
            )
        )
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
                    and(
                        eq(deployments.resourceId, resourceId),
                        eq(deployments.outcome, "success")
                    )
                )
                .orderBy(desc(deployments.finishedAt), desc(deployments.id))
                .limit(1);

            return deployment ?? null;
        },
        { inputKey: "resourceId" }
    )
);

export const getDeploymentLogBatch = query(
    DeploymentLogBatchInput,
    withRemoteLogging(
        "deployments.getDeploymentLogBatch",
        "query",
        fetchDeploymentLogBatch,
        {
            inputKey: "deploymentId",
        }
    )
);

// Live queries
export const listDeployments = query.live(
    ResourceIdInput,
    withRemoteLiveLogging("deployments.listDeployments", streamDeployments, {
        inputKey: "resourceId",
    })
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
        { inputKey: "deploymentId" }
    )
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
        { inputKey: "deploymentId" }
    )
);

const streamOrganizationDeployments =
    async function* streamOrganizationDeployments() {
        const session = requireSession();
        const { request } = getRequestEvent();
        const organizationId = await getOrganizationIdForUser(
            session.user.id,
            session.session.activeOrganizationId
        );

        if (!organizationId) {
            kitError(403, "No organization membership");
        }

        for await (const deploymentsPage of Stream.toAsyncIterable(
            deploymentsStream(organizationId)
        )) {
            if (request.signal.aborted) {
                return;
            }

            yield deploymentsPage;
        }
    };

// Stream all deployments visible to the active organization for the global
// deployments page. The server-side stream owns the database query so no
// queue payloads or credentials cross the remote-function boundary.
export const liveDeployments = query.live(
    withRemoteLiveLogging("deployments.liveDeployments", () =>
        streamOrganizationDeployments()
    )
);
