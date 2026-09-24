import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    clusterMonitoring,
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import { ucClient, UcApiError, unwrap, type LogEvent, type Service } from "@stoat/uncloud";
import { sql as greptimeSql, GreptimeResponseTooLargeError } from "@stoat/workflows/greptime";
import {
    ALLOY_SERVICE,
    GREPTIME_SERVICE,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, desc, DrizzleQueryError, eq, sql } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { organizationProcedure, resourceMiddleware } from "../..";
import { formatComposeFile, resourceComposePrefix } from "../../compose";
import { cancellableStream } from "../../stream";

export type ResourceLog = {
    timestamp: string;
    serviceId: string;
    serviceName: string;
    message: string;
    machine: string | null;
    container: string | null;
    stream: string | null;
};

export type ResourceLogCursor = string;

export type ResourceLogEvent =
    | {
          type: "services";
          services: { id: string; name: string }[];
          historyAvailable: boolean;
          retentionDays: number | null;
      }
    | { type: "logs"; logs: ResourceLog[] }
    | { type: "reset"; serviceId: string; replacement?: { id: string; name: string } }
    | { type: "status"; serviceId: string; state: "connected" | "reconnecting" | "error"; message?: string };

type LogService = Service;

type LogCluster = { id: string; sidecarUrl: string; sidecarToken: string };

const scopeInput = { projectId: z.uuid(), resourceId: z.uuid() };

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u);

const selectionInput = {
    ...scopeInput,
    serviceIds: z
        .array(identifier)
        .min(1)
        .max(20)
        .refine((ids) => new Set(ids).size === ids.length),
};

const timestamp = z.iso.datetime({ offset: true }).max(40);

const cursorSchema = z.object({
    scope: z.string(),
    timestamp,
    offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

const optionalLabel = z.string().max(1024).nullish();

const logMessage = z
    .string()
    .max(32 * 1024)
    .refine((message) => Buffer.byteLength(message) <= 32 * 1024);

const liveEvent = z.object({
    timestamp,
    message: logMessage.optional(),
    error: z.string().optional(),
    stream: z.enum(["stdout", "stderr", "heartbeat", "unknown"]),
    metadata: z
        .object({
            serviceId: optionalLabel,
            machineId: optionalLabel,
            containerId: optionalLabel,
        })
        .optional(),
});

const historicalRow = z.tuple([
    z.string().max(40),
    identifier,
    logMessage,
    z.string().max(1024).nullable(),
    z.string().max(1024).nullable(),
    z.string().max(1024).nullable(),
]);

function bounded(signal?: AbortSignal, ms = 20_000) {
    const timeout = AbortSignal.timeout(ms);

    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function canonicalTime(value: string) {
    const fraction = /\.(\d+)/u.exec(value)?.[1] ?? "";

    if (fraction.length > 9)
        throw new ORPCError("BAD_REQUEST", { message: "Use at most nanosecond precision." });
    const seconds = value.replace(/\.\d+/u, "");
    const millis = Date.parse(seconds);
    const nanos = BigInt(millis) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));

    if (nanos < 0n || nanos > 9_223_372_036_854_775_807n)
        throw new ORPCError("BAD_REQUEST", {
            message: "Timestamp is outside the supported range.",
        });

    return {
        nanos,
        text: `${new Date(millis).toISOString().slice(0, 19)}.${fraction.padEnd(9, "0")}Z`,
    };
}

// Standard SQL strings, not LIKE patterns: %, _ and backslashes remain literal.
function literal(value: string) {
    if (value.includes("\0"))
        throw new ORPCError("BAD_REQUEST", { message: "NUL is not allowed in log searches." });

    return `'${value.replaceAll("'", "''")}'`;
}

async function deployedServices(
    db: Database,
    cluster: LogCluster,
    resource: typeof resources.$inferSelect,
    signal: AbortSignal,
) {
    const candidates = await db
        .select({
            id: deployments.id,
            status: deployments.status,
        })
        .from(deployments)
        .innerJoin(
            resourceDeploymentInputs,
            eq(resourceDeploymentInputs.deploymentId, deployments.id),
        )
        .where(
            and(
                eq(deployments.resourceId, resource.id),
                eq(deployments.clusterId, cluster.id),
                sql`(${deployments.status} = 'ready' OR EXISTS (
                SELECT 1 FROM deployment_logs l WHERE l.deployment_id = ${deployments.id}
                AND l.text = 'Deploying Compose to the cluster.' AND l.metadata->>'event' = 'step'
            ))`,
            ),
        )
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(101)
        .catch((error) => {
            if (
                error instanceof DrizzleQueryError &&
                z.object({ code: z.enum(["42P01", "42703"]) }).safeParse(error.cause).success
            )
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: "Database schema is out of date. Run pnpm db:migrate on the server.",
                });

            throw new ORPCError("INTERNAL_SERVER_ERROR", {
                message: "Unable to read resource deployment history.",
            });
        });

    const names = new Set<string>();

    if (candidates.length === 0 && resource.spec?.trim()) {
        const [tracked] = await db
            .select({ id: deployments.id })
            .from(deployments)
            .where(eq(deployments.resourceId, resource.id))
            .limit(1);

        // Imported resources predate deployment snapshots. Resolve their saved
        // Compose names just like Overview, then accept only services that exist.
        if (!tracked)
            for (const name of formatComposeFile(resource.spec, resourceComposePrefix(resource))
                .serviceNames)
                names.add(name);
    }

    // A failed partial deploy can leave services from the last successful snapshot alive.
    // Include subsequent attempted snapshots, never a queued or editable draft.
    for (const [index, candidate] of candidates.entries()) {
        if (index === 100) throw new Error("Too many deployment snapshots.");
        signal.throwIfAborted();

        // Fetch one body at a time and stop at the latest ready deployment. Older
        // candidates are metadata only, not up to 101 copies of a 4 MiB spec.
        const [snapshot] = await db
            .select({
                spec: resourceDeploymentInputs.spec,
                prefix: resourceDeploymentInputs.prefix,
            })
            .from(resourceDeploymentInputs)
            .where(eq(resourceDeploymentInputs.deploymentId, candidate.id));

        if (!snapshot) throw new Error("Deployment snapshot is unavailable.");

        for (const name of formatComposeFile(snapshot.spec, snapshot.prefix).serviceNames)
            names.add(name);

        if (candidate.status === "ready") break;
    }

    if (names.size > 100) throw new Error("Too many deployed services.");
    const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });
    const services: LogService[] = [];
    const serviceNames = [...names].filter((name) => name !== GREPTIME_SERVICE && name !== ALLOY_SERVICE && !name.startsWith("stoat-monitoring-"));

    for (let offset = 0; offset < serviceNames.length; offset += 8) {
        const batch = await Promise.all(serviceNames.slice(offset, offset + 8).map(async (name) => {
            signal.throwIfAborted();

            if (!identifier.safeParse(name).success) throw new Error("Invalid deployed service name.");

            const result = await uc.GET("/api/v1/services/{id}", {
                params: { path: { id: name } },
                signal,
            });

            if (result.response.status === 404) return null;
            const service = await unwrap(Promise.resolve(result));

            if (service.name !== name || !identifier.safeParse(service.id).success)
                throw new Error("Invalid service inspection.");

            return service;
        }));

        for (const service of batch) if (service) services.push(service);
    }

    return { services, names: serviceNames };
}

function selectedServices(services: LogService[], ids: string[]) {
    return ids.map((id) => {
        const service = services.find((service) => service.id === id);

        if (!service)
            throw new ORPCError("BAD_REQUEST", {
                message:
                    "Select only current deployed resource services. Refresh the service list.",
            });

        return service;
    });
}

async function logHistory(
    db: Database,
    cluster: {
        id: string;
        initializedAt: Date | null;
        configuration: { retentionDays: number } | null;
    },
) {
    const [monitoring] = await db
        .select({ id: clusterMonitoring.clusterId })
        .from(clusterMonitoring)
        .where(eq(clusterMonitoring.clusterId, cluster.id));

    const historyAvailable = Boolean(monitoring && cluster.initializedAt);

    return {
        historyAvailable,
        retentionDays: historyAvailable ? (cluster.configuration?.retentionDays ?? null) : null,
    };
}

async function requireLiveAccess(
    db: Database,
    sessionId: string,
    sessionToken: string,
    userId: string,
    organizationId: string,
    projectId: string,
    resourceId: string,
    clusterId: string,
    signal: AbortSignal,
) {
    const expired = new AbortController();
    const cancelled = Promise.withResolvers<never>();

    const stop = () => {
        expired.abort();
        cancelled.reject(new Error("Log authorization interrupted or timed out."));
    };

    const timer = setTimeout(stop, 5_000);
    signal.addEventListener("abort", stop, { once: true });

    if (signal.aborted) stop();

    try {
        await Promise.race([
            cancelled.promise,
            db.transaction(async (tx) => {
                // The independent deadline also covers pool acquisition/BEGIN. If a
                // queued acquisition completes late, skip authorization and release it.
                expired.signal.throwIfAborted();
                await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                expired.signal.throwIfAborted();

                const result = await tx.execute(sql`SELECT 1 FROM session s
            JOIN "user" u ON u.id = s.user_id
            JOIN member m ON m.user_id = u.id AND m.organization_id = ${organizationId}
            JOIN clusters c ON c.organization_id = m.organization_id AND c.id = ${clusterId}
            JOIN projects p ON p.cluster_id = c.id AND p.id = ${projectId} AND p.is_internal IS NOT TRUE
            JOIN resources r ON r.project_id = p.id AND r.id = ${resourceId} AND r.type = 'compose'
            WHERE s.id = ${sessionId} AND s.user_id = ${userId} AND s.active_organization_id = ${organizationId}
            AND s.token = ${sessionToken}
            AND s.expires_at > now()
            AND (u.banned IS NOT TRUE OR u.ban_expires <= now()) LIMIT 1`);

                if (!result.rowCount)
                    throw new ORPCError("FORBIDDEN", {
                        message: "Log access expired. Sign in and refresh the resource.",
                    });
            }),
        ]);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
    }
}

async function* serviceEvents(
    cluster: LogCluster,
    service: LogService,
    signal: AbortSignal,
): AsyncGenerator<ResourceLogEvent> {
    const controller = new AbortController();
    const upstreamSignal = AbortSignal.any([signal, controller.signal]);
    const opened = Promise.withResolvers<void>();
    let validated = false;
    let retryable = true;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let iterator: AsyncGenerator<LogEvent> | undefined;

    try {
        const uc = ucClient(cluster.sidecarUrl, {
            token: cluster.sidecarToken,
            // Observe headers without changing the existing uc.stream.serviceLogs transport.
            fetch: async (request, options) => {
                const response = await fetch(request, options);

                if (
                    !response.ok ||
                    !response.body ||
                    !response.headers.get("content-type")?.startsWith("text/event-stream")
                ) {
                    retryable = [404, 408, 429].includes(response.status) || response.status >= 500;
                    await response.body?.cancel();
                    throw new Error("Unable to open log stream.");
                }

                const reader = response.body.getReader();

                const cancel = () => {
                    void reader.cancel().catch(() => {});
                };

                upstreamSignal.addEventListener("abort", cancel, { once: true });

                if (upstreamSignal.aborted) cancel();
                let frameBytes = 0;
                let lineBytes = 0;

                const body = new ReadableStream<Uint8Array>({
                    async pull(target) {
                        try {
                            const { value, done } = await reader.read();

                            if (done) {
                                target.close();

                                return;
                            }

                            if (value.byteLength > 1024 * 1024) {
                                retryable = false;
                                throw new Error("Log chunk too large.");
                            }

                            // Bound even incomplete/malicious SSE frames before the shared parser buffers them.
                            for (const byte of value) {
                                if (++frameBytes > 64 * 1024) {
                                    retryable = false;
                                    throw new Error("Log frame too large.");
                                }

                                if (byte === 10) {
                                    if (lineBytes === 0) frameBytes = 0;
                                    lineBytes = 0;
                                } else if (byte !== 13) lineBytes++;
                            }

                            target.enqueue(value);
                        } catch (error) {
                            target.error(error);
                            cancel();
                        }
                    },
                    async cancel() {
                        upstreamSignal.removeEventListener("abort", cancel);
                        await reader.cancel().catch(() => {});
                    },
                });

                clearTimeout(timeout);
                validated = true;
                opened.resolve();

                return new Response(body, { headers: response.headers });
            },
        });

        iterator = uc.stream.serviceLogs(service.id, {
            follow: true,
            tail: 100,
            signal: upstreamSignal,
        });
        let next = iterator.next();
        void next.catch(() => {});
        await Promise.race([opened.promise, next]);

        if (!validated || upstreamSignal.aborted) throw new Error("Unable to open log stream.");
        yield { type: "status", serviceId: service.id, state: "connected" };

        for (;;) {
            const result = await next;

            if (upstreamSignal.aborted) break;

            if (result.done) throw new Error("Log stream closed.");
            const event = liveEvent.parse(result.value);

            if (event.error) throw new Error("Service log failure.");

            if (event.stream !== "heartbeat") {
                if (
                    event.message === undefined ||
                    (event.metadata?.serviceId && event.metadata.serviceId !== service.id)
                ) {
                    retryable = false;
                    throw new Error("Invalid service log event.");
                }

                yield {
                    type: "logs",
                    logs: [
                        {
                            timestamp: canonicalTime(event.timestamp).text,
                            serviceId: service.id,
                            serviceName: service.name,
                            message: event.message,
                            machine: event.metadata?.machineId ?? null,
                            container: event.metadata?.containerId ?? null,
                            stream: event.stream === "unknown" ? null : event.stream,
                        },
                    ],
                };
            }

            next = iterator.next();
        }

        if (!signal.aborted) throw new Error("Log stream interrupted.");
    } catch (error) {
        controller.abort();
        retryable = retryable && !(error instanceof z.ZodError) && !(error instanceof ORPCError);

        if (!signal.aborted)
            yield {
                type: "status",
                serviceId: service.id,
                state: retryable ? "reconnecting" : "error",
                message: retryable
                    ? "Service logs interrupted. Retrying automatically."
                    : "Invalid log response or exceeded the 32 KiB log / 64 KiB event limit. Reconnect to retry.",
            };
    } finally {
        clearTimeout(timeout);
        controller.abort();
        await iterator?.return(undefined).catch(() => {});
    }
}

async function* followServiceEvents(
    cluster: LogCluster,
    service: LogService,
    signal: AbortSignal,
    refreshers: Map<string, () => Promise<void>>,
    rediscover: () => ReturnType<typeof deployedServices>,
): AsyncGenerator<ResourceLogEvent> {
    const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });
    const watcherId = service.id;
    let cycle = new AbortController();
    let replacement: LogService | undefined;
    let fingerprint: string | undefined;
    let inspectionError: "retry" | "terminal" | undefined;
    let inspecting = false;
    let waiting = false;
    const containerNames = new Map<string, string>();

    const refresh = async (initial?: LogService) => {
        if (inspecting || signal.aborted || inspectionError === "terminal") return;
        inspecting = true;
        let retryable = !initial;

        try {
            let current = initial ?? await unwrap(
                uc.GET("/api/v1/services/{id}", {
                    params: { path: { id: service.name } },
                    signal: bounded(signal, 5_000),
                }),
            );

            retryable = false;

            if (current.name !== service.name || !identifier.safeParse(current.id).success)
                throw new Error("Invalid service identity.");

            if (current.id !== service.id) {
                // A name match alone is not enough: recheck the resource's current deployed scope.
                retryable = true;
                const deployed = await rediscover();
                signal.throwIfAborted();

                if (!deployed.names.includes(service.name)) {
                    retryable = false;
                    throw new Error("Service is no longer deployed for this resource.");
                }

                const next = deployed.services.find((candidate) => candidate.name === service.name);

                if (!next) throw new Error("Deployed service is temporarily unavailable.");
                retryable = false;
                current = next;
            }

            const containers = z
                .array(
                    z.object({
                        machineId: z.string(),
                        container: z.object({
                            Id: z.string(),
                            Name: optionalLabel,
                            State: z
                                .object({
                                    Running: z.boolean().optional(),
                                    Status: z.string().optional(),
                                })
                                .nullish(),
                        }),
                    }),
                )
                .parse(current.containers);

            containerNames.clear();

            for (const { machineId, container } of containers) {
                const name = container.Name?.replace(/^\//u, "");

                if (name) containerNames.set(`${machineId}:${container.Id}`, name);
            }

            const next = JSON.stringify(
                containers
                    .map(({ machineId, container }) =>
                        JSON.stringify([
                            machineId,
                            container.Id,
                            container.State?.Running ?? null,
                            container.State?.Status ?? null,
                        ]),
                    )
                    .sort(),
            );

            inspectionError = undefined;
            replacement = current.id === service.id ? undefined : current;

            if (fingerprint !== undefined && (replacement || next !== fingerprint || waiting)) cycle.abort();
            fingerprint = next;
        } catch (error) {
            if (!signal.aborted) {
                inspectionError = retryable && (!(error instanceof UcApiError) || [404, 408, 429].includes(error.status) || error.status >= 500)
                    ? "retry" : "terminal";
                cycle.abort();
            }
        } finally {
            inspecting = false;
        }
    };

    refreshers.set(watcherId, refresh);

    try {
        // Discovery already inspected this service; reuse it instead of another round trip.
        await refresh(service);

        while (!signal.aborted) {
            const combined = AbortSignal.any([signal, cycle.signal]);
            const changed = Promise.withResolvers<void>();
            const wake = () => changed.resolve();
            combined.addEventListener("abort", wake, { once: true });

            if (combined.aborted) wake();

            try {
                if (inspectionError) {
                    const failure = inspectionError;
                    waiting = true;
                    yield {
                        type: "status",
                        serviceId: service.id,
                        state: failure === "retry" ? "reconnecting" : "error",
                        message: failure === "retry"
                            ? "Service could not be inspected. Retrying automatically."
                            : "Service is no longer in this resource or its inspection was invalid.",
                    };

                    if (failure === "terminal") return;
                } else {
                    for await (const event of serviceEvents(cluster, service, combined)) {
                        if (event.type === "status" && event.state === "reconnecting") waiting = true;

                        if (event.type === "logs")
                            for (const log of event.logs)
                                if (log.container) log.container = containerNames.get(`${log.machine}:${log.container}`) ?? log.container;
                        yield event;

                        if (event.type === "status" && event.state === "error") return;
                    }
                }

                // Retry only after the next successful inspection, even if replicas are unchanged.
                waiting = true;
                await changed.promise;
            } finally {
                combined.removeEventListener("abort", wake);
            }

            if (signal.aborted) return;
            cycle = new AbortController();
            waiting = false;

            if (!inspectionError) {
                const serviceId = service.id;

                if (replacement) {
                    service = replacement;
                    replacement = undefined;
                    yield { type: "reset", serviceId, replacement: { id: service.id, name: service.name } };
                } else yield { type: "reset", serviceId };
            }
        }
    } finally {
        refreshers.delete(watcherId);
        cycle.abort();
    }
}

const logProcedure = organizationProcedure
    .input(z.object(scopeInput))
    .use(resourceMiddleware)
    .use(async ({ context, next }) => {
        if (context.resource.type !== "compose") throw new ORPCError("NOT_FOUND");

        const [cluster] = await context.db
            .select({
                id: clusters.id,
                sidecarUrl: clusters.sidecarUrl,
                sidecarToken: clusters.sidecarToken,
                initializedAt: clusters.initializedAt,
                configuration: clusters.initializationConfiguration,
            })
            .from(clusters)
            .innerJoin(projects, eq(projects.clusterId, clusters.id))
            .where(
                and(
                    eq(projects.id, context.resource.projectId),
                    eq(clusters.organizationId, context.organizationId),
                ),
            );

        if (!cluster) throw new ORPCError("NOT_FOUND");

        return next({ context: { logCluster: cluster } });
    });

export const resourceLogsRouter = {
    listLogServices: logProcedure.handler(
        async ({ context: { db, logCluster, resource }, signal }) => {
            try {
                const { services } = await deployedServices(db, logCluster, resource, bounded(signal));
                const history = await logHistory(db, logCluster);

                return {
                    // Inspections include container environment values; only expose identity here.
                    services: services.map(({ id, name }) => ({ id, name })),
                    ...history,
                };
            } catch (error) {
                if (error instanceof ORPCError) throw error;
                throw new ORPCError("BAD_GATEWAY", {
                    message: "Unable to inspect deployed log services. Check sidecar connectivity.",
                });
            }
        },
    ),

    streamLogs: logProcedure.input(z.object({
        ...selectionInput,
        serviceIds: selectionInput.serviceIds.optional(),
        serviceNames: selectionInput.serviceIds.optional(),
    }).refine((input) => input.serviceIds === undefined || input.serviceNames === undefined, {
        message: "Select services by either ID or name, not both.",
    })).handler(({ context, input, signal }) =>
        cancellableStream(async function* (signal): AsyncGenerator<ResourceLogEvent> {
            const { db, logCluster, session, organizationId } = context;
            const controller = new AbortController();
            const combined = AbortSignal.any([signal, controller.signal]);
            let failure: ORPCError<string, unknown> | undefined;
            let checking = false;
            const refreshers = new Map<string, () => Promise<void>>();
            let rediscovering: ReturnType<typeof deployedServices> | undefined;

            const rediscover = () => {
                // Share a refresh when several services are recreated in the same deployment.
                rediscovering ??= (async () => {
                    const [resource] = await db.select().from(resources).where(and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        eq(resources.type, "compose"),
                    ));

                    combined.throwIfAborted();

                    if (!resource) throw new ORPCError("NOT_FOUND");

                    return deployedServices(db, logCluster, resource, bounded(combined));
                })().finally(() => { rediscovering = undefined; });

                return rediscovering;
            };

            const check = async () => {
                if (checking || combined.aborted) return;
                checking = true;

                try {
                    await requireLiveAccess(
                        db,
                        session.session.id,
                        session.session.token,
                        session.user.id,
                        organizationId,
                        input.projectId,
                        input.resourceId,
                        logCluster.id,
                        combined,
                    );

                    // Replica discovery is per service and must never delay the auth deadline.
                    for (const refresh of refreshers.values()) void refresh();
                } catch {
                    if (combined.aborted) return;
                    failure = new ORPCError("FORBIDDEN", {
                        message:
                            "Log access expired or could not be verified. Refresh the resource.",
                    });
                    controller.abort();
                } finally {
                    checking = false;
                }
            };

            let interval: ReturnType<typeof setInterval> | undefined;
            const iterators: AsyncGenerator<ResourceLogEvent>[] = [];
            let wake = () => {};

            const abort = () => wake();
            combined.addEventListener("abort", abort, { once: true });

            try {
                if (combined.aborted) return;
                await check();

                if (failure) throw failure;

                if (combined.aborted) return;
                // Refresh authorization during discovery, idle tails and browser backpressure.
                interval = setInterval(() => {
                    void check();
                }, 15_000);
                let services: LogService[];

                try {
                    const discovered = await deployedServices(
                        db,
                        logCluster,
                        context.resource,
                        bounded(combined),
                    );

                    services = discovered.services;

                    if (input.serviceIds === undefined) {
                        const history = await logHistory(db, logCluster);

                        if (failure) throw failure;

                        if (combined.aborted) return;
                        yield {
                            type: "services",
                            services: services.map(({ id, name }) => ({ id, name })),
                            ...history,
                        };
                    }
                } catch (error) {
                    if (failure) throw failure;

                    if (combined.aborted) return;

                    if (error instanceof ORPCError) throw error;
                    throw new ORPCError("BAD_GATEWAY", {
                        message: "Unable to inspect deployed log services.",
                    });
                }

                if (failure) throw failure;

                if (combined.aborted) return;

                const selected = input.serviceNames !== undefined
                    ? services.filter((service) => input.serviceNames!.includes(service.name))
                    : input.serviceIds === undefined
                        ? services.slice(0, 20)
                        : selectedServices(services, input.serviceIds);

                // A deployment may temporarily remove selected names. End this attempt so
                // the live client rediscovers them, never broadening the user's selection.
                if (input.serviceNames && selected.length !== input.serviceNames.length) return;

                const ready: { index: number; result: IteratorResult<ResourceLogEvent> }[] = [];

                for (const service of selected)
                    iterators.push(followServiceEvents(logCluster, service, combined, refreshers, rediscover));

                // One outstanding read/event per service, including under a slow consumer.
                // Repeated Promise.race would accumulate handlers on every idle service.
                const read = (index: number) => {
                    void iterators[index]!.next()
                        .then((result) => {
                            ready.push({ index, result });
                            wake();
                        })
                        .catch(() => {
                            failure = new ORPCError("BAD_GATEWAY", {
                                message: "Log stream interrupted. Reconnect to retry.",
                            });
                            controller.abort();
                        });
                };

                iterators.forEach((_, index) => read(index));
                let remaining = iterators.length;

                while (remaining && !combined.aborted) {
                    if (!ready.length)
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });

                    if (combined.aborted) break;
                    const item = ready.shift()!;

                    if (item.result.done) remaining--;
                    else {
                        yield item.result.value;

                        if (!combined.aborted) read(item.index);
                    }
                }

                if (failure) throw failure;
            } finally {
                clearInterval(interval);
                controller.abort();
                combined.removeEventListener("abort", abort);
                await Promise.all(iterators.map((iterator) => iterator.return(undefined)));
            }
        }, signal),
    ),

    searchLogs: logProcedure
        .input(
            z.object({
                ...selectionInput,
                start: timestamp,
                end: timestamp,
                query: z
                    .string()
                    .max(4096)
                    .refine((value) => !value.includes("\0")),
                cursor: z.string().max(2048).optional(),
            }),
        )
        .handler(async ({ context: { db, logCluster, resource }, input, signal }) => {
            const start = canonicalTime(input.start);
            const end = canonicalTime(input.end);

            if (end.nanos <= start.nanos || end.nanos - start.nanos > 366n * 86_400_000_000_000n)
                throw new ORPCError("BAD_REQUEST", {
                    message: "Choose a positive time window of at most 366 days (end exclusive).",
                });
            const querySignal = bounded(signal, 30_000);

            try {
                const services = selectedServices(
                    (await deployedServices(db, logCluster, resource, querySignal)).services,
                    input.serviceIds,
                );

                const [monitoring] = await db
                    .select()
                    .from(clusterMonitoring)
                    .where(eq(clusterMonitoring.clusterId, logCluster.id));

                if (!monitoring || !logCluster.initializedAt)
                    throw new ORPCError("PRECONDITION_FAILED", {
                        message:
                            "Historical logs require initialized cluster monitoring. Live logs remain available.",
                    });

                const password = decryptMonitoringPassword(
                    monitoring.encryptedPassword,
                    process.env.BETTER_AUTH_SECRET ?? "",
                    logCluster.id,
                );

                const scope = createHash("sha256")
                    .update(
                        JSON.stringify([
                            logCluster.id,
                            input.projectId,
                            input.resourceId,
                            [...input.serviceIds].sort(),
                            start.text,
                            end.text,
                            input.query,
                        ]),
                    )
                    .digest("hex");

                const sign = (payload: string) =>
                    createHmac("sha256", password)
                        .update(`stoat/log-cursor/v2-desc:${payload}`)
                        .digest();

                let cursor: z.infer<typeof cursorSchema> | undefined;

                if (input.cursor) {
                    try {
                        const [payload, signature, extra] = input.cursor.split(".");

                        if (!payload || !signature || extra) throw new Error();
                        const decoded = Buffer.from(signature, "base64url");

                        if (decoded.length !== 32 || !timingSafeEqual(sign(payload), decoded))
                            throw new Error();
                        cursor = cursorSchema.parse(
                            JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
                        );
                        const time = canonicalTime(cursor.timestamp);

                        if (
                            cursor.scope !== scope ||
                            time.nanos < start.nanos ||
                            time.nanos >= end.nanos
                        )
                            throw new Error();
                    } catch {
                        throw new ORPCError("BAD_REQUEST", {
                            message: "Invalid log cursor. Restart this search.",
                        });
                    }
                }

                const uc = ucClient(logCluster.sidecarUrl, { token: logCluster.sidecarToken });

                const greptime = await unwrap(
                    uc.GET("/api/v1/services/{id}", {
                        params: { path: { id: GREPTIME_SERVICE } },
                        signal: querySignal,
                    }),
                );

                const columns = await greptimeSql(
                    uc,
                    greptime,
                    password,
                    `SELECT column_name FROM information_schema.columns WHERE table_schema = '${MONITORING_DATABASE}' AND table_name = 'docker_logs'`,
                    querySignal,
                );

                if (columns.length === 0) return { logs: [], nextCursor: null };
                const names = new Set(columns.map((row) => z.string().parse(row[0])));

                if (
                    ![
                        "greptime_timestamp",
                        "uncloud_service_id",
                        "line",
                        "machine_id",
                        "container",
                        "customer_id",
                    ].every((name) => names.has(name))
                )
                    throw new Error("Unexpected log table schema.");
                const stream = names.has("stream") ? '"stream"' : "CAST(NULL AS STRING)";

                // Walk older timestamps, retaining the boundary's unread ties via OFFSET.
                // Boundary OFFSET is stable for unchanged data, not snapshot isolation:
                // late arrivals/retention can shift equal-timestamp rows between requests.
                let pageSize = 200;
                let rows: unknown[][];

                for (;;) {
                    querySignal.throwIfAborted();

                    try {
                        rows = await greptimeSql(
                            uc,
                            greptime,
                            password,
                            `SELECT
                CAST(greptime_timestamp AS STRING) AS timestamp, uncloud_service_id, "line", machine_id, container, ${stream} AS log_stream
                FROM ${MONITORING_DATABASE}.docker_logs
                WHERE customer_id = ${literal(logCluster.id)}
                AND uncloud_service_id IN (${services.map((service) => literal(service.id)).join(", ")})
                AND greptime_timestamp >= to_timestamp_nanos(${literal(start.text)})
                AND greptime_timestamp < to_timestamp_nanos(${literal(end.text)})
                ${cursor ? `AND greptime_timestamp <= to_timestamp_nanos(${literal(cursor.timestamp)})` : ""}
                ${input.query ? `AND strpos(lower("line"), lower(${literal(input.query)})) > 0` : ""}
                ORDER BY greptime_timestamp DESC, uncloud_service_id ASC, machine_id ASC NULLS FIRST,
                    container ASC NULLS FIRST, "line" ASC, log_stream ASC NULLS FIRST
                LIMIT ${pageSize + 1} OFFSET ${cursor?.offset ?? 0}`,
                            querySignal,
                        );
                        break;
                    } catch (error) {
                        if (!(error instanceof GreptimeResponseTooLargeError) || pageSize === 1)
                            throw error;
                        // Retry the identical boundary, not a later page. Two maximum-size
                        // valid rows (one plus lookahead) fit even with nested JSON escaping.
                        pageSize = Math.max(1, Math.floor(pageSize / 2));
                    }
                }

                if (rows.length > pageSize + 1) throw new Error("Unexpected log page size.");

                const logs = rows.slice(0, pageSize).map((row): ResourceLog => {
                    const [time, serviceId, message, machine, container, stream] =
                        historicalRow.parse(row);

                    const service = services.find((service) => service.id === serviceId);

                    if (!service) throw new Error("Unexpected log service.");

                    const parsed = canonicalTime(
                        timestamp.parse(time.endsWith("Z") ? time : `${time}Z`),
                    );

                    if (parsed.nanos < start.nanos || parsed.nanos >= end.nanos)
                        throw new Error("Unexpected log timestamp.");

                    return {
                        timestamp: parsed.text,
                        serviceId,
                        serviceName: service.name,
                        message,
                        machine,
                        container,
                        stream,
                    };
                });

                while (Buffer.byteLength(JSON.stringify(logs)) > 1024 * 1024)
                    logs.length = Math.floor(logs.length / 2);

                let nextCursor: ResourceLogCursor | null = null;

                if (rows.length > logs.length) {
                    const last = logs.at(-1)!;

                    const offset =
                        logs.filter((log) => log.timestamp === last.timestamp).length +
                        (cursor?.timestamp === last.timestamp ? cursor.offset : 0);

                    if (!Number.isSafeInteger(offset))
                        throw new Error("Log cursor limit exceeded.");

                    const payload = Buffer.from(
                        JSON.stringify({ scope, timestamp: last.timestamp, offset }),
                    ).toString("base64url");

                    nextCursor = `${payload}.${sign(payload).toString("base64url")}`;
                }

                return { logs, nextCursor };
            } catch (error) {
                if (error instanceof ORPCError) throw error;
                throw new ORPCError("BAD_GATEWAY", {
                    message:
                        "Historical log query failed, timed out, or exceeded the 1 MiB response / 32 KiB row limit. Narrow the time window or search text.",
                });
            }
        }),
};
