import type { Database } from "@stoat/db";
import { appendDeploymentLog, getDeploymentByJobId } from "@stoat/db/deployments";
import { ucClient } from "@stoat/uncloud";
import { YAMLParseError } from "yaml";
import { formatComposeFile } from "./compose";
import { deployCompose, DeploymentError } from "./deploy-compose";

export const RESOURCE_FAILURE_MESSAGE =
    "Resource deployment failed. Check the Compose configuration and sidecar connectivity, then retry.";

export async function deployResource(db: Database, deploymentId: string, signal: AbortSignal) {
    let step = "Loading deployment input.";

    const log = (text: string, level: "info" | "debug" | "error" = "info", event = "step") =>
        appendDeploymentLog(db, deploymentId, text, { level, event });

    try {
        signal.throwIfAborted();
        const deployment = await getDeploymentByJobId(db, deploymentId);

        if (
            !deployment ||
            deployment.name !== "DeployResource" ||
            !deployment.resourceId ||
            !["queued", "running"].includes(deployment.status)
        )
            return;

        const lock = await db.$client.connect();
        const lockKey = `stoat:resource-deploy:${deployment.clusterId}`;
        let closing: Promise<void> | undefined;
        const close = () => (closing ??= lock.end());

        try {
            step = "Waiting for the cluster deployment lock.";
            const backend = await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            let cancelling: Promise<void> | undefined;

            const cancel = () => {
                // A socket close alone does not wake PostgreSQL's advisory-lock wait.
                cancelling = db.$client
                    .query("SELECT pg_cancel_backend($1)", [backend.rows[0]!.pid])
                    .then(() => {}, close);
            };

            signal.throwIfAborted();
            signal.addEventListener("abort", cancel, { once: true });

            try {
                await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
            } finally {
                // Once acquired, keep the lock until the sidecar stream has drained on abort.
                signal.removeEventListener("abort", cancel);
                await cancelling;
            }

            signal.throwIfAborted();

            // Claim after locking, so a cancellation while acquiring the lock wins.
            const claimed = await db.$client.query(
                `UPDATE deployments SET status = 'running', error = NULL, finished_at = NULL, updated_at = now()
                 WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
                [deploymentId],
            );

            if (!claimed.rowCount) return;
            step = "Loading deployment input.";
            await log(step);

            const input = await db.query.resourceDeploymentInputs.findFirst({
                where: (input, { eq }) => eq(input.deploymentId, deploymentId),
            });

            const cluster = await db.query.clusters.findFirst({
                columns: { sidecarUrl: true, sidecarToken: true },
                where: (cluster, { eq }) => eq(cluster.id, deployment.clusterId),
            });

            if (!input || !cluster) throw new Error(RESOURCE_FAILURE_MESSAGE);
            signal.throwIfAborted();
            step = "Formatting Compose snapshot.";
            await log(step);
            const compose = formatComposeFile(input.spec, input.prefix ?? undefined);

            if (compose.serviceCount === 0) throw new Error(RESOURCE_FAILURE_MESSAGE);
            await log(`Formatted ${compose.serviceCount} service(s).`);
            step = "Deploying Compose to the cluster.";
            await log(step);
            const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });
            await deployCompose(uc, compose.yaml, signal, log, undefined, [cluster.sidecarToken]);

            // Publish the captured source and ready status together, before releasing
            // the cluster lock. Cancellation wins without overwriting newer drafts.
            step = "Saving the deployed Compose snapshot.";
            await db.$client.query(
                `WITH ready AS (
                    UPDATE deployments SET status = 'ready', error = NULL, finished_at = now(), updated_at = now()
                    WHERE id = $1 AND status = 'running' RETURNING resource_id
                ), published AS (
                    UPDATE resources SET spec = $2, updated_at = now()
                    WHERE id IN (SELECT resource_id FROM ready) RETURNING id
                )
                INSERT INTO deployment_logs (deployment_id, text, metadata, created_at)
                SELECT $1, 'Resource deployment is ready.', '{"level":"info","event":"ready"}'::jsonb, now()
                FROM published`,
                [deploymentId, input.spec],
            );
        } finally {
            try {
                // Closing the dedicated session releases its advisory lock (or pending wait).
                await close();
            } finally {
                lock.release(true);
            }
        }
    } catch (error) {
        if (!signal.aborted) {
            const position = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;

            const reason =
                error instanceof DeploymentError
                    ? error.message
                    : error instanceof YAMLParseError
                      ? `Invalid Compose YAML: ${error.code}${position ? ` at line ${position.line}, column ${position.col}` : ""}.`
                      : `Attempt failed: ${step}`;

            await log(reason, "error", "attempt-failed").catch(() => {});
            await db.$client
                .query(
                    "UPDATE deployments SET error = $2, updated_at = now() WHERE id = $1 AND status IN ('queued', 'running')",
                    [deploymentId, reason],
                )
                .catch(() => {});
        }

        // Includes DB, YAML parser, transport, and cleanup errors. No raw cause reaches effect-mq.
        throw new Error(RESOURCE_FAILURE_MESSAGE);
    }
}
