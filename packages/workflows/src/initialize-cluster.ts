import type { Database } from "@stoat/db";
import {
    getInitialization,
    prepareMonitoring,
    updateMonitoringPassword,
} from "@stoat/db/initialization";
import { ucClient, unwrap, type UcClient, type Service } from "@stoat/uncloud";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import {
    ALLOY_SERVICE,
    GREPTIME_SERVICE,
    MONITORING_DATABASE,
    renderMonitoringCompose,
} from "./monitoring-compose";
import { decryptMonitoringPassword, encryptMonitoringPassword } from "./secrets";
import template from "../../../internal/monitoring/compose.yaml?raw";
import { sql } from "./greptime";

export { readSqlRows } from "./greptime";

import { appendDeploymentLog } from "@stoat/db/deployments";
import { deployCompose } from "./deploy-compose";

export type DeployLogFn = (text: string) => Promise<void>;

export async function deployMonitoring(
    uc: UcClient,
    compose: string,
    signal: AbortSignal,
    services?: string[],
    onLog?: DeployLogFn,
) {
    await deployCompose(
        uc,
        compose,
        signal,
        async (text) => {
            await onLog?.(text);
        },
        services,
    );
}

function healthy(service: Service, machines: string[], requireHealthcheck: boolean) {
    return machines.every((id) =>
        service.containers.some((entry) => {
            const state = Schema.decodeUnknownSync(
                Schema.UndefinedOr(
                    Schema.Struct({
                        Running: Schema.optionalKey(Schema.Boolean),
                        Health: Schema.optionalKey(
                            Schema.Struct({ Status: Schema.optionalKey(Schema.String) }),
                        ),
                    }),
                ),
            )(entry.container.State);

            if (entry.machineId !== id || state?.Running !== true) return false;

            // Alloy ships no Docker healthcheck (its image has neither curl nor
            // wget), so Running is the only signal there. GreptimeDB does define
            // one, so it must report healthy. Either way the authenticated
            // ingestion check below is the real end-to-end readiness gate.
            return requireHealthcheck ? state.Health?.Status === "healthy" : true;
        }),
    );
}

async function inspect(uc: UcClient, id: string, signal: AbortSignal) {
    return unwrap(uc.GET("/api/v1/services/{id}", { params: { path: { id } }, signal }));
}

async function waitForService(
    uc: UcClient,
    name: string,
    machines: string[],
    signal: AbortSignal,
    requireHealthcheck: boolean,
) {
    for (let attempt = 0; attempt < 30; attempt++) {
        signal.throwIfAborted();
        const service = await inspect(uc, name, bounded(signal, 15_000));

        if (healthy(service, machines, requireHealthcheck)) return service;
        await delay(2_000, undefined, { signal });
    }

    throw new Error("Monitoring containers did not become healthy.");
}

// Sidecar calls get their own ceilings so a hung endpoint fails fast with a
// clear error instead of stalling the attempt forever. Combined with the
// attempt signal so cancellation still propagates.
function bounded(signal: AbortSignal, ms: number) {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

async function checkOwnership(uc: UcClient, clusterId: string, signal: AbortSignal) {
    const { items } = await unwrap(uc.GET("/api/v1/services", { signal }));

    for (const service of items.filter(
        (item) => item.name === GREPTIME_SERVICE || item.name === ALLOY_SERVICE,
    )) {
        const detail = await inspect(uc, service.id, signal);

        if (
            detail.containers.length === 0 ||
            detail.containers.some(({ container }) => {
                const config = Schema.decodeUnknownSync(
                    Schema.UndefinedOr(
                        Schema.Struct({
                            Env: Schema.optionalKey(Schema.Array(Schema.String)),
                        }),
                    ),
                )(container.Config);

                return !config?.Env?.includes(`STOAT_MONITORING_CLUSTER_ID=${clusterId}`);
            })
        )
            throw new Error("Monitoring service names are already in use by another deployment.");
    }
}

export function createInitializeClusterHandler(
    db: Database,
    encryptionSecret: string,
    opts?: { deploymentId?: string },
) {
    // Validate before accepting jobs, including when the database contains no requests yet.
    encryptMonitoringPassword("validation", encryptionSecret, "startup");

    // Best-effort narrative for the deployment detail view. Failures here must
    // never fail the deployment itself.
    const log: DeployLogFn = async (text: string) => {
        if (!opts?.deploymentId) return;

        try {
            await appendDeploymentLog(db, opts.deploymentId, text);
        } catch {
            /* ignore */
        }
    };

    return async (clusterId: string, signal: AbortSignal) => {
        const lock = await db.$client.connect();
        let acquired = false;

        try {
            const result = await lock.query(
                "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
                [`stoat:initialize:${clusterId}`],
            );

            acquired = result.rows[0]?.acquired === true;

            if (!acquired) throw new Error("Cluster initialization is already running.");
            signal.throwIfAborted();
            const cluster = await getInitialization(db, clusterId);

            if (cluster.initializedAt) {
                await log("Cluster is already initialized; nothing to do.");

                return;
            }

            await log("Starting cluster monitoring initialization.");
            const config = cluster.initializationConfiguration!;
            const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });

            const machines = await unwrap(
                uc.GET("/api/v1/machines", {
                    params: { query: { available: true } },
                    signal: bounded(signal, 30_000),
                }),
            );

            const target = machines.items.find((machine) => machine.id === config.machineId);

            if (!target) {
                throw new Error("The selected monitoring machine is unavailable.");
            }

            await log(
                `Using machine "${target.name}" for GreptimeDB storage (${config.retentionDays}-day retention).`,
            );
            await checkOwnership(uc, clusterId, bounded(signal, 60_000));

            const state = await prepareMonitoring(
                db,
                clusterId,
                encryptMonitoringPassword(
                    randomBytes(32).toString("hex"),
                    encryptionSecret,
                    clusterId,
                ),
                template,
            );

            let password: string;

            try {
                password = decryptMonitoringPassword(
                    state.encryptedPassword,
                    encryptionSecret,
                    clusterId,
                );
            } catch {
                // App secret rotated since issuance: re-issue credentials and
                // redeploy with them instead of failing forever.
                password = randomBytes(32).toString("hex");
                await updateMonitoringPassword(
                    db,
                    clusterId,
                    encryptMonitoringPassword(password, encryptionSecret, clusterId),
                );
                await log("Stored monitoring credentials were unreadable; issued fresh ones.");
            }

            const compose = renderMonitoringCompose(template, config, password, clusterId);
            await log("Deploying GreptimeDB…");
            await deployMonitoring(
                uc,
                compose,
                bounded(signal, 10 * 60_000),
                [GREPTIME_SERVICE],
                log,
            );
            await log("Waiting for GreptimeDB to become healthy…");

            const greptime = await waitForService(
                uc,
                GREPTIME_SERVICE,
                [state.machineId],
                bounded(signal, 90_000),
                true,
            );

            await log("GreptimeDB is healthy. Creating monitoring database…");
            await sql(
                uc,
                greptime,
                password,
                `CREATE DATABASE IF NOT EXISTS ${MONITORING_DATABASE} WITH (ttl = '${config.retentionDays}d')`,
                bounded(signal, 60_000),
            );
            await log("Deploying Alloy collectors…");
            await deployMonitoring(uc, compose, bounded(signal, 10 * 60_000), undefined, log);
            const expectedMachines = machines.items.map((machine) => machine.id);
            await log(`Waiting for Alloy collectors on ${expectedMachines.length} machine(s)…`);
            await waitForService(
                uc,
                ALLOY_SERVICE,
                expectedMachines,
                bounded(signal, 90_000),
                false,
            );
            // Readiness includes end-to-end authenticated ingestion, not just processes.
            await log("Verifying metrics and log ingestion…");

            for (let attempt = 0; attempt < 40; attempt++) {
                signal.throwIfAborted();

                try {
                    const querySignal = bounded(signal, 60_000);

                    const metrics = await sql(
                        uc,
                        greptime,
                        password,
                        `SELECT DISTINCT machine_id FROM ${MONITORING_DATABASE}.node_uname_info`,
                        querySignal,
                    );

                    const logs = await sql(
                        uc,
                        greptime,
                        password,
                        `SELECT COUNT(*) FROM ${MONITORING_DATABASE}.docker_logs`,
                        querySignal,
                    );

                    if (
                        expectedMachines.every((id) => metrics.some((row) => row[0] === id)) &&
                        Number(logs[0]?.[0]) > 0
                    ) {
                        await log(
                            `Ingestion verified on ${expectedMachines.length} machine(s). Monitoring is ready.`,
                        );
                        // Persist the source template, never the rendered monitoring credentials.
                        await db.$client.query(
                            "UPDATE resources SET spec = $1, updated_at = now() WHERE id = $2",
                            [template, state.resourceId],
                        );

                        return;
                    }
                } catch {
                    signal.throwIfAborted();
                }

                if (attempt > 0 && attempt % 10 === 0) {
                    await log(`Still verifying ingestion (attempt ${attempt + 1}/40)…`);
                }

                await delay(3_000, undefined, { signal });
            }

            throw new Error("Monitoring ingestion could not be verified.");
        } catch {
            signal.throwIfAborted();
            // Intentionally redact underlying database, Compose and HTTP errors.
            throw new Error(
                "Cluster monitoring initialization failed. Check the selected machine, storage paths, and sidecar connectivity, then retry.",
            );
        } finally {
            try {
                if (acquired)
                    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
                        `stoat:initialize:${clusterId}`,
                    ]);
            } finally {
                lock.release();
            }
        }
    };
}
