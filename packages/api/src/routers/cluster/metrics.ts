import { ORPCError } from "@orpc/server";
import { clusterMonitoring, clusters } from "@stoat/db/schema/index";
import { ucClient, unwrap } from "@stoat/uncloud";
import { sql as greptimeSql } from "@stoat/workflows/greptime";
import { GREPTIME_SERVICE, MONITORING_DATABASE } from "@stoat/workflows/monitoring-compose";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { organizationProcedure } from "../..";

export type Usage = { used: number; total: number } | null;

/** Absolute usage summed across machines: CPU in cores (1 busy vCPU = 1), memory and disk in bytes. */
export type ClusterMetrics =
    | { available: false; reason: "uninitialized" | "unreachable" }
    | { available: true; machines: number; cpu: Usage; memory: Usage; disk: Usage };

const db = MONITORING_DATABASE;

function usage(row: unknown[] | undefined): Usage {
    const used = Number(row?.[0]);
    const total = Number(row?.[1]);

    return row?.[0] != null && row[1] != null && Number.isFinite(used) && Number.isFinite(total) && total > 0
        ? { used: Math.min(total, Math.max(0, used)), total }
        : null;
}

export const metricsRouter = {
    getClusterMetrics: organizationProcedure
        .input(v.object({ clusterId: v.pipe(v.string(), v.uuid()) }))
        .handler(
            async ({
                context: { db: database, organizationId },
                input,
                signal,
            }): Promise<ClusterMetrics> => {
                const [cluster] = await database
                    .select({
                        id: clusters.id,
                        sidecarUrl: clusters.sidecarUrl,
                        sidecarToken: clusters.sidecarToken,
                        initializedAt: clusters.initializedAt,
                        encryptedPassword: clusterMonitoring.encryptedPassword,
                    })
                    .from(clusters)
                    .leftJoin(clusterMonitoring, eq(clusterMonitoring.clusterId, clusters.id))
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .limit(1);

                if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

                if (!cluster.initializedAt || !cluster.encryptedPassword)
                    return { available: false, reason: "uninitialized" };

                const querySignal = AbortSignal.any([
                    ...(signal ? [signal] : []),
                    AbortSignal.timeout(20_000),
                ]);

                try {
                    const password = decryptMonitoringPassword(
                        cluster.encryptedPassword,
                        process.env.BETTER_AUTH_SECRET ?? "",
                        cluster.id,
                    );

                    const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });

                    const greptime = await unwrap(
                        uc.GET("/api/v1/services/{id}", {
                            params: { path: { id: GREPTIME_SERVICE } },
                            signal: querySignal,
                        }),
                    );

                    // The cluster id comes from our own database and is a validated UUID.
                    const customer = `'${cluster.id}'`;

                    const recent = (alias: string) =>
                        `${alias}.customer_id = ${customer} AND ${alias}.greptime_timestamp >= now() - INTERVAL '5 minutes'`;

                    const query = (text: string) =>
                        greptimeSql(uc, greptime, password, text, querySignal);

                    const [cpu, memory, disk] = await Promise.all([
                        // Busy cores over the last five minutes: each core's non-idle share, summed.
                        query(`SELECT sum(1 - idle / total), count(*)
                            FROM (
                                SELECT machine_id, cpu,
                                    sum(CASE WHEN mode = 'idle' THEN d ELSE 0 END) AS idle,
                                    sum(d) AS total
                                FROM (
                                    SELECT c.machine_id, c.cpu, c.mode,
                                        max(c.greptime_value) - min(c.greptime_value) AS d
                                    FROM ${db}.node_cpu_seconds_total c
                                    WHERE ${recent("c")}
                                    GROUP BY c.machine_id, c.cpu, c.mode
                                )
                                GROUP BY machine_id, cpu
                            )
                            WHERE total > 0`),
                        query(`SELECT sum(t - a), sum(t)
                            FROM (
                                SELECT a.machine_id, avg(a.greptime_value) AS a, avg(t.greptime_value) AS t
                                FROM ${db}."node_memory_MemAvailable_bytes" a
                                JOIN ${db}."node_memory_MemTotal_bytes" t
                                    ON a.machine_id = t.machine_id
                                    AND a.customer_id = t.customer_id
                                    AND a.greptime_timestamp = t.greptime_timestamp
                                WHERE ${recent("a")}
                                GROUP BY a.machine_id
                            )`),
                        query(`SELECT sum(s - f), sum(s), count(*)
                            FROM (
                                SELECT f.machine_id, avg(f.greptime_value) AS f, avg(s.greptime_value) AS s
                                FROM ${db}.node_filesystem_free_bytes f
                                JOIN ${db}.node_filesystem_size_bytes s
                                    ON f.machine_id = s.machine_id
                                    AND f.customer_id = s.customer_id
                                    AND f.mountpoint = s.mountpoint
                                    AND f.device = s.device
                                    AND f.greptime_timestamp = s.greptime_timestamp
                                WHERE ${recent("f")} AND f.mountpoint = '/'
                                GROUP BY f.machine_id
                            )`),
                    ]);

                    return {
                        available: true,
                        machines: Number(disk[0]?.[2]) || 0,
                        cpu: usage(cpu[0]),
                        memory: usage(memory[0]),
                        disk: usage(disk[0]),
                    };
                } catch {
                    signal?.throwIfAborted();

                    return { available: false, reason: "unreachable" };
                }
            },
        ),
};
