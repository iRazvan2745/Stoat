import template from "../../internal/monitoring/compose.yaml?raw";
import type { ClusterInitializationConfiguration } from "@stoat/db/schema/index";
import { describe, expect, it } from "vite-plus/test";
import { parse, stringify } from "yaml";
import { readSqlRows } from "../../packages/workflows/src/initialize-cluster";
import {
    ALLOY_SERVICE,
    GREPTIME_SERVICE,
    renderMonitoringCompose,
} from "../../packages/workflows/src/monitoring-compose";

const config: ClusterInitializationConfiguration = {
    machineId: "machine-1",
    greptimeStorage: { type: "volume", source: "greptime-data" },
    alloyStorage: { type: "bind", source: "/srv/alloy" },
    retentionDays: 14,
};

it("returns SQL rows from all result sets in order, including nullable cells", () => {
    expect(
        readSqlRows(
            JSON.stringify({
                code: 0,
                output: [
                    {
                        records: {
                            rows: [
                                ["machine-1", 1],
                                ["machine-2", null],
                            ],
                        },
                    },
                    { affectedrows: 0 },
                    { records: { rows: [] } },
                    { records: { rows: [["machine-3", 2]] } },
                ],
            }),
        ),
    ).toEqual([
        ["machine-1", 1],
        ["machine-2", null],
        ["machine-3", 2],
    ]);
});

it.each([{ code: 0, output: [] }, { output: [{ affectedrows: 1 }] }])(
    "accepts successful SQL responses without records: %j",
    (response) => {
        expect(readSqlRows(JSON.stringify(response))).toEqual([]);
    },
);

it.each([
    ["nonzero status despite valid rows", { code: 1, output: [{ records: { rows: [[1]] } }] }],
    ["error despite successful status", { code: 0, error: "failed", output: [] }],
    ["missing output", { code: 0 }],
    ["null response", null],
    ["array response", []],
    ["string status", { code: "0", output: [] }],
    ["null error", { error: null, output: [] }],
    ["object output", { output: {} }],
    ["null output", { output: null }],
    ["null result set", { output: [null] }],
    ["null records", { output: [{ records: null }] }],
    ["string rows", { output: [{ records: { rows: "invalid" } }] }],
    ["null rows", { output: [{ records: { rows: null } }] }],
    ["scalar row", { output: [{ records: { rows: [1] } }] }],
    ["object row", { output: [{ records: { rows: [{ machine: "machine-1" }] } }] }],
    ["null row", { output: [{ records: { rows: [null] } }] }],
    [
        "malformed later result set",
        { output: [{ records: { rows: [[1]] } }, { records: { rows: [false] } }] },
    ],
])("rejects SQL responses with %s", (_name, response) => {
    expect(() => readSqlRows(JSON.stringify(response))).toThrow();
});

it.each(["", "not JSON", '{"output":['])("rejects malformed SQL JSON: %j", (response) => {
    expect(() => readSqlRows(response)).toThrow(SyntaxError);
});

it("renders the bundled monitoring template with isolated storage and private services", () => {
    const compose = parse(renderMonitoringCompose(template, config, "password", "cluster-1"));

    expect(Object.keys(compose.services)).toEqual([GREPTIME_SERVICE, ALLOY_SERVICE]);
    expect(compose.name).toBe("stoat-monitoring");
    expect(compose.volumes).toEqual({ greptime_data: { name: "greptime-data" } });
    expect(compose.services[ALLOY_SERVICE].volumes[0]).toMatchObject({
        type: "bind",
        source: "/srv/alloy",
        bind: { create_host_path: false },
    });
    expect(compose.services[ALLOY_SERVICE].environment.GREPTIME_PASSWORD).toBe("password");

    for (const service of Object.values(compose.services)) {
        expect(service).not.toHaveProperty("ports");
        expect(service).not.toHaveProperty("x-ports");
        expect(service).not.toHaveProperty("x-caddy");
    }
});

describe.each([GREPTIME_SERVICE, ALLOY_SERVICE])("%s template guards", (serviceName) => {
    it.each(["ports", "x-ports", "x-caddy"])("rejects public exposure through %s", (key) => {
        const input = parse(template);
        input.services[serviceName][key] =
            key === "x-caddy"
                ? "monitoring.example.test { reverse_proxy {{upstreams 4006}} }"
                : ["4006:4006"];

        expect(() =>
            renderMonitoringCompose(stringify(input), config, "password", "cluster-1"),
        ).toThrow("Monitoring services must not publish host ports or ingress routes.");
    });

    it("rejects a missing required service", () => {
        const input = parse(template);
        delete input.services[serviceName];

        expect(() =>
            renderMonitoringCompose(stringify(input), config, "password", "cluster-1"),
        ).toThrow("Monitoring template is missing required services.");
    });
});

it.each([
    ["volume", "volume"],
    ["volume", "bind"],
    ["bind", "volume"],
    ["bind", "bind"],
] as const)("renders Greptime %s and Alloy %s storage", (greptimeType, alloyType) => {
    const settings: ClusterInitializationConfiguration = {
        ...config,
        greptimeStorage: {
            type: greptimeType,
            source: greptimeType === "bind" ? "/srv/greptime" : "chosen-greptime",
        },
        alloyStorage: {
            type: alloyType,
            source: alloyType === "bind" ? "/srv/alloy" : "chosen-alloy",
        },
    };

    const compose = parse(renderMonitoringCompose(template, settings, "password", "cluster-1"));
    const volumes: Record<string, { name: string }> = {};

    for (const [serviceName, storage, key, target] of [
        [GREPTIME_SERVICE, settings.greptimeStorage, "greptime_data", "/greptimedb_data"],
        [ALLOY_SERVICE, settings.alloyStorage, "alloy_data", "/var/lib/alloy/data"],
    ] as const) {
        if (storage.type === "volume") {
            volumes[key] = { name: storage.source };
            expect(compose.services[serviceName].volumes[0]).toEqual({
                type: "volume",
                source: key,
                target,
            });
        } else {
            expect(compose.services[serviceName].volumes[0]).toEqual({
                type: "bind",
                source: storage.source,
                target,
                bind: { create_host_path: false },
            });
        }
    }

    expect(compose.volumes).toEqual(volumes);
    expect(compose.services[ALLOY_SERVICE].volumes.slice(1)).toEqual(
        parse(template).services[ALLOY_SERVICE].volumes.slice(1),
    );
});

it.each([
    "/var/lib/alloy/data",
    "old-data:/var/lib/alloy/data",
    "old-data:/var/lib/alloy/data:rw",
    {
        type: "volume",
        source: "old-data",
        target: "/var/lib/alloy/data",
    },
])("replaces Alloy's data mount while preserving unrelated mounts: %j", (dataMount) => {
    const input = parse(template);

    const unrelated = [
        ...input.services[ALLOY_SERVICE].volumes.slice(1),
        "/srv/config:/etc/alloy/extra:ro",
    ];

    input.services[ALLOY_SERVICE].volumes = [...unrelated, dataMount];

    const compose = parse(
        renderMonitoringCompose(stringify(input), config, "password", "cluster-1"),
    );

    expect(compose.services[ALLOY_SERVICE].volumes).toEqual([
        {
            type: "bind",
            source: "/srv/alloy",
            target: "/var/lib/alloy/data",
            bind: { create_host_path: false },
        },
        ...unrelated,
    ]);
});

it.each([
    "/greptimedb_data",
    "old-data:/greptimedb_data:rw",
    { type: "volume", source: "old-data", target: "/greptimedb_data" },
])("preserves extra Greptime mounts when replacing its data mount: %j", (dataMount) => {
    const input = parse(template);

    const unrelated = {
        type: "bind",
        source: "/srv/greptime-config",
        target: "/etc/extra",
        read_only: true,
    };

    input.services[GREPTIME_SERVICE].volumes = [unrelated, dataMount];

    const compose = parse(
        renderMonitoringCompose(stringify(input), config, "password", "cluster-1"),
    );

    expect(compose.services[GREPTIME_SERVICE].volumes).toEqual([
        { type: "volume", source: "greptime_data", target: "/greptimedb_data" },
        unrelated,
    ]);
});

it("preserves Alloy mounts whose targets only share the data path prefix", () => {
    const input = parse(template);
    const unrelated = "/srv/backups:/var/lib/alloy/data-backup:ro";
    input.services[ALLOY_SERVICE].volumes.push(unrelated);

    const compose = parse(
        renderMonitoringCompose(stringify(input), config, "password", "cluster-1"),
    );

    expect(compose.services[ALLOY_SERVICE].volumes).toContain(unrelated);
});

it.each([
    "extra:/var/lib/alloy/extra",
    { type: "volume", source: "extra", target: "/var/lib/alloy/extra" },
])("preserves named-volume declarations used by unrelated Alloy mounts: %j", (extraMount) => {
    const input = parse(template);
    input.volumes.extra = { name: "alloy-extra", external: true };
    input.services[ALLOY_SERVICE].volumes.push(extraMount);

    const compose = parse(
        renderMonitoringCompose(stringify(input), config, "password", "cluster-1"),
    );

    expect(compose.services[ALLOY_SERVICE].volumes).toContainEqual(extraMount);
    expect(compose.volumes.extra).toEqual(input.volumes.extra);
});

it("keeps managed volume definitions still referenced by other mounts in bind mode", () => {
    const input = parse(template);
    input.volumes.greptime_data = { name: "existing-greptime", external: true };
    input.services[ALLOY_SERVICE].volumes.push("greptime_data:/mnt/greptime:ro");

    const compose = parse(
        renderMonitoringCompose(
            stringify(input),
            {
                ...config,
                greptimeStorage: { type: "bind", source: "/srv/greptime" },
            },
            "password",
            "cluster-1",
        ),
    );

    expect(compose.volumes).toEqual({ greptime_data: input.volumes.greptime_data });
    expect(compose.services[ALLOY_SERVICE].volumes).toContain("greptime_data:/mnt/greptime:ro");
});

it("sets cluster ownership, pins only Greptime, and leaves Alloy machine identity to Uncloud", () => {
    const input = parse(template);
    input.services[GREPTIME_SERVICE]["x-machines"] = ["old-machine", "other-machine"];
    input.services[GREPTIME_SERVICE].environment.STOAT_MONITORING_CLUSTER_ID = "old-cluster";
    Object.assign(input.services[ALLOY_SERVICE].environment, {
        STOAT_MONITORING_CLUSTER_ID: "old-cluster",
        CUSTOMER_ID: "old-customer",
        UNCLOUD_MACHINE_ID: "wrong-machine",
        MACHINE_ID: "wrong-machine",
        EXTRA_SETTING: "preserved",
    });

    const compose = parse(
        renderMonitoringCompose(
            stringify(input),
            { ...config, retentionDays: 30 },
            "password",
            "cluster-1",
        ),
    );

    const greptime = compose.services[GREPTIME_SERVICE];
    const alloy = compose.services[ALLOY_SERVICE];

    expect(greptime["x-machines"]).toEqual(["machine-1"]);
    expect(greptime.environment).toMatchObject({
        STOAT_MONITORING_CLUSTER_ID: "cluster-1",
        GREPTIMEDB_STANDALONE__USER_PROVIDER: "static_user_provider:cmd:stoat=password",
    });
    expect(alloy).not.toHaveProperty("x-machines");
    expect(alloy.deploy.mode).toBe("global");
    expect(alloy.environment).toMatchObject({
        STOAT_MONITORING_CLUSTER_ID: "cluster-1",
        CUSTOMER_ID: "cluster-1",
        GREPTIME_URL: "http://stoat-monitoring-greptimedb.internal:4006",
        GREPTIME_DB: "monitoring",
        GREPTIME_USERNAME: "stoat",
        GREPTIME_PASSWORD: "password",
        EXTRA_SETTING: "preserved",
    });
    expect(String(alloy.environment.RETENTION_DAYS)).toBe("30");
    expect(alloy.environment).not.toHaveProperty("UNCLOUD_MACHINE_ID");
    expect(alloy.environment).not.toHaveProperty("MACHINE_ID");
    expect(compose.configs.alloy_config.content).toContain('sys.env("UNCLOUD_MACHINE_ID")');
});
