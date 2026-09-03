import { describe, expect, it } from "vite-plus/test";

import type { DeploymentLogRecord } from "#lib/domain/deployments/logs";
import {
    buildDeploymentLogEntries,
    formatDeployPlanMessage,
    formatDeploymentLogMessage,
    getDeploymentLogSection,
    insertLogSectionHeaders,
    isDebugDeploymentLog,
    parseDeploymentProgress,
} from "#lib/domain/deployments/logs";

const log = (
    partial: Partial<DeploymentLogRecord> & Pick<DeploymentLogRecord, "id" | "message">,
): DeploymentLogRecord => ({
    createdAt: new Date("2026-08-19T12:17:34.000Z"),
    stream: "stdout",
    ...partial,
});

describe("isDebugDeploymentLog", () => {
    it("treats git internals and compose paths as debug", () => {
        expect(
            isDebugDeploymentLog(log({ id: 1, message: "Checking git status in /tmp/infra" })),
        ).toBe(true);
        expect(
            isDebugDeploymentLog(
                log({
                    id: 2,
                    message: "Wrote compose file to /tmp/infra/svc/compose.yaml",
                }),
            ),
        ).toBe(true);
        expect(isDebugDeploymentLog(log({ id: 3, message: "Committed changes: abc123" }))).toBe(
            true,
        );
    });

    it("keeps user-facing deployment lines visible", () => {
        expect(
            isDebugDeploymentLog(
                log({
                    id: 1,
                    message: "Preparing deployment for service Nginx (nginx-f7gzq)",
                }),
            ),
        ).toBe(false);
        expect(isDebugDeploymentLog(log({ id: 2, message: "Saved compose changes to git" }))).toBe(
            false,
        );
        expect(
            isDebugDeploymentLog(log({ id: 3, message: "Deploy error: boom", stream: "stderr" })),
        ).toBe(false);
    });

    it("treats the debug stream as debug even for otherwise useful messages", () => {
        expect(
            isDebugDeploymentLog(
                log({
                    id: 1,
                    message: "Saved compose changes to git",
                    stream: "debug",
                }),
            ),
        ).toBe(true);
    });
});

describe("formatDeploymentLogMessage", () => {
    it("rewrites the old plan format into a sentence", () => {
        expect(
            formatDeploymentLogMessage(
                "Plan: run service=nginx-f7gzq-nginx machine=hazel image=nginx",
            ),
        ).toBe("Start nginx-f7gzq-nginx on machine hazel (image nginx)");
    });

    it("strips the plan prefix from already readable plan lines", () => {
        expect(
            formatDeploymentLogMessage(
                "Plan: Start nginx-f7gzq-nginx on machine hazel (image nginx)",
            ),
        ).toBe("Start nginx-f7gzq-nginx on machine hazel (image nginx)");
    });

    it("rewrites a successful deploy-complete status", () => {
        expect(formatDeploymentLogMessage("Deploy complete: deployed")).toBe("Deployment finished");
    });

    it("removes ANSI styling before formatting deployment messages", () => {
        expect(formatDeploymentLogMessage("\u001b[32mDeploy complete: deployed\u001b[0m")).toBe(
            "Deployment finished",
        );
    });
});

describe("formatDeployPlanMessage", () => {
    it("describes a run operation in plain language", () => {
        expect(
            formatDeployPlanMessage([
                {
                    action: "run",
                    image: "nginx",
                    machine: "hazel",
                    service: "nginx-f7gzq-nginx",
                },
            ]),
        ).toBe("Plan: Start nginx-f7gzq-nginx on machine hazel (image nginx)");
    });
});

describe("parseDeploymentProgress", () => {
    it("labels a running container instead of only showing the name", () => {
        const parsed = parseDeploymentProgress(
            "Progress: Container nginx-f7gzq-nginx-3xhi on hazel phase=done status=Running",
        );

        expect(parsed).toMatchObject({
            detail: "Machine: hazel",
            label: "Started container nginx-f7gzq-nginx-3xhi",
            status: "Running",
        });
    });

    it("labels an image pull with the machine as detail", () => {
        const parsed = parseDeploymentProgress(
            "Progress: Image nginx on hazel phase=done status=Pulled",
        );

        expect(parsed).toMatchObject({
            detail: "Machine: hazel",
            label: "Pulled image nginx",
            status: "Pulled",
        });
    });
});

describe("insertLogSectionHeaders", () => {
    it("groups a typical deployment into readable sections and hides debug by default", () => {
        const entries = buildDeploymentLogEntries([
            log({
                id: 1,
                message: "Preparing deployment for service Nginx (nginx-f7gzq)",
            }),
            log({ id: 2, message: "Parsed compose file with 1 services" }),
            log({ id: 3, message: "Checking git status in /tmp/infra" }),
            log({
                id: 4,
                message: "Plan: run service=nginx-f7gzq-nginx machine=hazel image=nginx",
            }),
            log({
                id: 5,
                message:
                    "Progress: Container nginx-f7gzq-nginx-3xhi on hazel phase=done status=Running",
            }),
            log({ id: 6, message: "Deploy complete: deployed" }),
            log({ id: 7, message: "Deployed service Nginx (nginx-f7gzq)" }),
        ]);

        const visible = insertLogSectionHeaders(
            entries.filter((entry) => entry.kind !== "text" || !entry.debug),
        );
        const titles = visible
            .filter((entry) => entry.kind === "section")
            .map((entry) => (entry.kind === "section" ? entry.title : ""));

        expect(titles).toEqual(["Preparing", "Plan", "Rolling out", "Finished"]);

        const textLines = visible.flatMap((entry) => (entry.kind === "text" ? entry.lines : []));
        expect(textLines).toContain("Preparing deployment for service Nginx (nginx-f7gzq)");
        expect(textLines).toContain("Start nginx-f7gzq-nginx on machine hazel (image nginx)");
        expect(textLines).toContain("Deployment finished");
        expect(textLines.some((line) => line.includes("Checking git status"))).toBe(false);
    });
});

describe("getDeploymentLogSection", () => {
    it("puts stderr into the error section", () => {
        expect(getDeploymentLogSection(log({ id: 1, message: "boom", stream: "stderr" }))).toBe(
            "error",
        );
    });
});
