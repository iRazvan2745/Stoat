import type { ClusterInitializationConfiguration, MonitoringStorage } from "@stoat/db/schema/index";
import { parse, stringify } from "yaml";
import { Predicate } from "effect";

export const GREPTIME_SERVICE = "stoat-monitoring-greptimedb";

export const ALLOY_SERVICE = "stoat-monitoring-alloy";

export const MONITORING_DATABASE = "monitoring";

export const GREPTIME_USERNAME = "stoat";

type ComposeService = {
    environment?: Record<string, string>;
    volumes?: Array<
        | string
        | { type: string; source: string; target: string; bind?: { create_host_path: boolean } }
    >;
    "x-machines"?: string[];
    ports?: string[];
    "x-ports"?: string[];
    "x-caddy"?: string;
};

type Compose = {
    name?: string;
    services: Record<string, ComposeService>;
    volumes?: Record<string, { name: string }>;
    configs: Record<string, { content: string }>;
};

function mount(storage: MonitoringStorage, target: string, key: string, compose: Compose) {
    if (storage.type === "bind") {
        return { type: "bind", source: storage.source, target, bind: { create_host_path: false } };
    }

    compose.volumes ??= {};
    compose.volumes[key] = { name: storage.source };

    return { type: "volume", source: key, target };
}

/** Render the trusted template in memory; the credential-bearing result is never persisted. */
export function renderMonitoringCompose(
    template: string,
    config: ClusterInitializationConfiguration,
    password: string,
    clusterId: string,
) {
    const greptimeUrl = `http://${GREPTIME_SERVICE}.internal:4006`;

    const replacements = new Map([
        ["GREPTIME_USERNAME", GREPTIME_USERNAME],
        ["GREPTIME_PASSWORD", password],
        ["GREPTIME_URL", greptimeUrl],
        ["GREPTIME_DB", MONITORING_DATABASE],
        ["GREPTIME_MACHINE", config.machineId],
        ["GREPTIME_MACHINE_ID", config.machineId],
        ["CLUSTER_ID", clusterId],
        ["RETENTION_DAYS", String(config.retentionDays)],
    ]);

    const substituted = template.replace(
        /\$\{([A-Z_]+)(?::[^}]*)?\}/g,
        (original, key: string) => replacements.get(key) ?? original,
    );

    // SAFETY: this is the repository-owned monitoring template, not user Compose input.
    const compose = parse(substituted) as Compose;
    const greptime = compose.services[GREPTIME_SERVICE] ?? compose.services.greptimedb;
    const alloy = compose.services[ALLOY_SERVICE] ?? compose.services.alloy;

    if (!greptime || !alloy) throw new Error("Monitoring template is missing required services.");
    compose.services = { [GREPTIME_SERVICE]: greptime, [ALLOY_SERVICE]: alloy };
    compose.name = "stoat-monitoring";
    compose.volumes ??= {};

    greptime["x-machines"] = [config.machineId];

    for (const [service, storage, target, key] of [
        [greptime, config.greptimeStorage, "/greptimedb_data", "greptime_data"],
        [alloy, config.alloyStorage, "/var/lib/alloy/data", "alloy_data"],
    ] as const) {
        service.volumes = [
            mount(storage, target, key, compose),
            ...(service.volumes ?? []).filter(
                (value) =>
                    (Predicate.isString(value) ? (value.split(":")[1] ?? value) : value.target) !==
                    target,
            ),
        ];
    }

    const volumeSources = new Set(
        [greptime, alloy].flatMap((service) =>
            (service.volumes ?? []).map((value) =>
                Predicate.isString(value)
                    ? value.split(":")[0]
                    : value.type === "volume"
                      ? value.source
                      : undefined,
            ),
        ),
    );

    for (const key of Object.keys(compose.volumes)) {
        if (!volumeSources.has(key)) delete compose.volumes[key];
    }

    alloy.environment = {
        ...alloy.environment,
        GREPTIME_URL: greptimeUrl,
        GREPTIME_DB: MONITORING_DATABASE,
        GREPTIME_USERNAME,
        GREPTIME_PASSWORD: password,
        CUSTOMER_ID: clusterId,
    };
    delete alloy.environment.UNCLOUD_MACHINE_ID;
    delete alloy.environment.MACHINE_ID;

    for (const service of [greptime, alloy]) {
        service.environment = { ...service.environment, STOAT_MONITORING_CLUSTER_ID: clusterId };

        if (service.ports || service["x-ports"] || service["x-caddy"]) {
            throw new Error("Monitoring services must not publish host ports or ingress routes.");
        }
    }

    return stringify(compose);
}
