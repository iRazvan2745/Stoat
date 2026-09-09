import { describe, expect, it } from "vite-plus/test";

import type { DeploymentLogRecord } from "#lib/domain/deployments/logs";

import {
    buildDeploymentLogView,
    getChangeSummary,
    getEmptyLogFilterMessage,
} from "../src/routes/(resource)/workspace/[workspaceId]/[resourceId]/deployments/deployment-log-view.ts";

const log = (
    partial: Partial<DeploymentLogRecord> & Pick<DeploymentLogRecord, "id" | "message">,
): DeploymentLogRecord => ({
    createdAt: new Date("2026-08-19T12:17:34.000Z"),
    stream: "stdout",
    ...partial,
});

describe("getChangeSummary", () => {
    it("parses a git-style change line", () => {
        expect(getChangeSummary("Changes: 3, insertions: 12, deletions: 4")).toEqual({
            changes: 3,
            deletions: 4,
            insertions: 12,
        });
    });

    it("returns null for unrelated messages", () => {
        expect(getChangeSummary("Preparing deployment")).toBeNull();
    });
});

describe("getEmptyLogFilterMessage", () => {
    it("explains missing errors, hidden debug output, and empty output", () => {
        expect(getEmptyLogFilterMessage("stderr", 0, false)).toBe("No errors in this deployment.");
        expect(getEmptyLogFilterMessage("all", 4, false)).toBe(
            "No output to show. Enable debug logs to see internal details.",
        );
        expect(getEmptyLogFilterMessage("stdout", 0, false)).toBe("No output in this deployment.");
    });
});

describe("buildDeploymentLogView", () => {
    it("counts streams and hides debug lines by default", () => {
        const view = buildDeploymentLogView(
            [
                log({
                    id: 1,
                    message: "Preparing deployment for service Nginx (nginx-f7gzq)",
                }),
                log({
                    id: 2,
                    message: "Wrote compose file to /tmp/infra/svc/compose.yaml",
                }),
                log({ id: 3, message: "Deploy error: boom", stream: "stderr" }),
            ],
            { logFilter: "all", showDebugLogs: false },
        );

        expect(view).toMatchObject({
            allCount: 2,
            debugCount: 1,
            stderrCount: 1,
            stdoutCount: 1,
            visibleLogsCount: 2,
        });
    });

    it("includes debug lines when requested", () => {
        const view = buildDeploymentLogView(
            [
                log({
                    id: 1,
                    message: "Preparing deployment for service Nginx (nginx-f7gzq)",
                }),
                log({
                    id: 2,
                    message: "Wrote compose file to /tmp/infra/svc/compose.yaml",
                }),
            ],
            { logFilter: "all", showDebugLogs: true },
        );

        expect(view.allCount).toBe(2);
        expect(view.stdoutCount).toBe(2);
        expect(view.visibleLogsCount).toBe(2);
    });
});
