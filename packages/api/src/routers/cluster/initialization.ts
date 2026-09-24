import { ORPCError } from "@orpc/server";
import { createDeployment } from "@stoat/db/deployments";
import { clusterMonitoring, clusters } from "@stoat/db/schema/index";
import { unwrap } from "@stoat/uncloud";
import { GREPTIME_USERNAME, MONITORING_DATABASE } from "@stoat/workflows/monitoring-compose";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { organizationAdminProcedure, organizationProcedure, uncloudMiddleware } from "../..";

const clusterInput = v.object({ clusterId: v.pipe(v.string(), v.uuid()) });

const storageInput = v.pipe(
    v.object({
        type: v.picklist(["volume", "bind"]),
        source: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
    }),
    v.check(
        ({ type, source }) =>
            type === "volume"
                ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(source)
                : /^\/(?:srv|mnt|data|opt|var\/lib)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(
                      source,
                  ) &&
                  !source.split("/").some((part) => part === ".." || part === ".") &&
                  !/^\/var\/lib\/(?:docker|containerd)(?:\/|$)/.test(source),
        "Use a valid volume name or a dedicated absolute data path under /srv, /mnt, /data, /opt, or /var/lib.",
    ),
);

export const initializationConfigurationInput = v.pipe(
    v.object({
        machineId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        greptimeStorage: storageInput,
        alloyStorage: storageInput,
        retentionDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
    }),
    v.check(
        (config) => config.greptimeStorage.source !== config.alloyStorage.source,
        "Greptime and Alloy must use separate storage locations.",
    ),
);

export const initializationRouter = {
    getInitializationOptions: organizationAdminProcedure
        .input(clusterInput)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc, organizationId }, input }) => {
            const [cluster] = await db
                .select({ configuration: clusters.initializationConfiguration })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const [machines, volumes] = await Promise.all([
                unwrap(
                    uc.GET("/api/v1/machines", {
                        params: { query: { available: true } },
                        signal: AbortSignal.timeout(15_000),
                    }),
                ),
                unwrap(uc.GET("/api/v1/volumes", { signal: AbortSignal.timeout(15_000) })),
            ]);

            return {
                machines: machines.items.map(({ id, name, state }) => ({ id, name, state })),
                volumes: volumes.items.flatMap(({ machineId, machineName, volume }) => {
                    const name = volume.Name ?? volume.name;

                    return v.is(v.string(), name) ? [{ machineId, machineName, name }] : [];
                }),
                configuration: cluster?.configuration ?? null,
            };
        }),
    initializeCluster: organizationAdminProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                configuration: initializationConfigurationInput,
            }),
        )
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc, organizationId }, input }) => {
            const machines = await unwrap(
                uc.GET("/api/v1/machines", {
                    params: { query: { available: true } },
                    signal: AbortSignal.timeout(15_000),
                }),
            );

            if (!machines.items.some((machine) => machine.id === input.configuration.machineId)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "Choose an available machine from this cluster.",
                });
            }

            // The saved request is the durable outbox: committing it is sufficient even
            // if the worker or its queue connection is temporarily unavailable.
            const requestedAt = new Date();

            return db.transaction(async (tx) => {
                const [cluster] = await tx
                    .update(clusters)
                    .set({
                        initializationConfiguration: input.configuration,
                        initializationRequestedAt: requestedAt,
                        initializationStatus: "queued",
                        initializationError: null,
                    })
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                            eq(clusters.initializationStatus, "uninitialized"),
                        ),
                    )
                    .returning({ id: clusters.id });

                if (!cluster)
                    throw new ORPCError("CONFLICT", {
                        message:
                            "Initialization was already requested. Retry the existing initialization instead.",
                    });

                // Every request gets its own deployment row so the cluster page can
                // show Vercel-style history with per-attempt logs.
                const deployment = await createDeployment(tx, {
                    clusterId: cluster.id,
                    name: "InitializeCluster",
                    jobId: `${cluster.id}:${requestedAt.toISOString()}`,
                    configuration: input.configuration,
                });

                return {
                    id: cluster.id,
                    initializationStatus: "queued" as const,
                    deploymentId: deployment.id,
                };
            });
        }),
    retryInitialization: organizationAdminProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const requestedAt = new Date();

            return db.transaction(async (tx) => {
                const [cluster] = await tx
                    .update(clusters)
                    .set({
                        initializationRequestedAt: requestedAt,
                        initializationStatus: "queued",
                        initializationError: null,
                    })
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                            eq(clusters.initializationStatus, "failed"),
                        ),
                    )
                    .returning({
                        id: clusters.id,
                        configuration: clusters.initializationConfiguration,
                    });

                if (!cluster)
                    throw new ORPCError("CONFLICT", {
                        message: "Only failed initialization can be retried.",
                    });

                const deployment = await createDeployment(tx, {
                    clusterId: cluster.id,
                    name: "InitializeCluster",
                    jobId: `${cluster.id}:${requestedAt.toISOString()}`,
                    configuration: cluster.configuration,
                });

                return {
                    id: cluster.id,
                    initializationStatus: "queued" as const,
                    deploymentId: deployment.id,
                };
            });
        }),
};

const monitoringFallbackHttpUrl = "http://stoat-monitoring-greptimedb.internal:4000";

/** Dashboard/SQL endpoint derived from the stored ingest URL (same host, port 4000). */
function dashboardUrlFor(ingestUrl: string | null) {
    if (!ingestUrl) return monitoringFallbackHttpUrl;

    try {
        const url = new URL(ingestUrl);
        url.port = "4000";
        url.pathname = "";
        url.search = "";

        return url.toString().replace(/\/$/, "");
    } catch {
        return monitoringFallbackHttpUrl;
    }
}

export const monitoringRouter = {
    getMonitoringConnection: organizationProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id, greptimeUrl: clusters.greptimeUrl })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

            const [monitoring] = await db
                .select()
                .from(clusterMonitoring)
                .where(eq(clusterMonitoring.clusterId, cluster.id))
                .limit(1);

            if (!monitoring) return { configured: false as const };

            const isAdmin = organizationRole
                .split(",")
                .some((part) => part.trim() === "owner" || part.trim() === "admin");

            // The password only ever leaves the server for owners/admins. A null
            // password for an admin means the app secret rotated since issuance;
            // re-running initialization issues fresh credentials.
            let password: string | null = null;

            if (isAdmin) {
                const secret = process.env.BETTER_AUTH_SECRET;

                if (secret) {
                    try {
                        password = decryptMonitoringPassword(
                            monitoring.encryptedPassword,
                            secret,
                            cluster.id,
                        );
                    } catch {
                        password = null;
                    }
                }
            }

            return {
                configured: true as const,
                database: MONITORING_DATABASE,
                username: GREPTIME_USERNAME,
                ingestUrl:
                    cluster.greptimeUrl ?? "http://stoat-monitoring-greptimedb.internal:4006",
                httpUrl: dashboardUrlFor(cluster.greptimeUrl),
                password,
                canReveal: isAdmin,
            };
        }),
};
