import { expect, it } from "vite-plus/test";

import { filterContainerLogs } from "#lib/domain/resources/container-logs";
import type { ContainerLogRecord } from "#lib/domain/resources/container-logs";

const logs: ContainerLogRecord[] = [
    {
        id: 1,
        containerId: "a",
        containerLabel: "api",
        machineName: "one",
        message: "\u001b[31mConnection FAILED\u001b[0m",
        stream: "stderr",
        timestamp: "2026-09-05T00:00:00Z",
    },
    {
        id: 2,
        containerId: "b",
        containerLabel: "web",
        machineName: "one",
        message: "Connection ready",
        stream: "stdout",
        timestamp: "2026-09-05T00:00:01Z",
    },
];

it("combines container, case-insensitive visible text and stderr filters", () => {
    expect(filterContainerLogs(logs, ["a"], " connection failed ", true)).toEqual([logs[0]]);
    expect(filterContainerLogs(logs, ["b"], "connection", true)).toEqual([]);
    expect(filterContainerLogs(logs, [], "connection")).toEqual(logs);
    expect(filterContainerLogs(logs, [], "31m")).toEqual([]);
});

it("reuses the snapshot array when no filters are active", () => {
    expect(filterContainerLogs(logs, [], "  ")).toBe(logs);
});
