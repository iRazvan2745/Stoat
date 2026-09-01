import { describe, expect, it } from "vite-plus/test";

import type { Deployment } from "../src/routes/(service)/workspace/[workspaceId]/[serviceId]/deployments/deployment.ts";
import {
    getDisplayStatus,
    getDuration,
    getPhase,
    getShortId,
    isDeploymentActive,
} from "../src/routes/(service)/workspace/[workspaceId]/[serviceId]/deployments/deployment.ts";

const deployment = (partial: Partial<Deployment> = {}): Deployment => ({
    createdAt: new Date("2026-08-19T12:00:00.000Z"),
    finishedAt: null,
    id: "abcdef1234567890",
    jobId: null,
    outcome: null,
    queuedAt: null,
    serviceId: "svc_1",
    settings: {},
    startedAt: null,
    updatedAt: new Date("2026-08-19T12:00:00.000Z"),
    ...partial,
});

describe("getPhase", () => {
    it("returns pending when no timestamps are set", () => {
        expect(getPhase(deployment())).toBe("pending");
    });

    it("returns queued, started, then finished as timestamps appear", () => {
        expect(getPhase(deployment({ queuedAt: new Date("2026-08-19T12:01:00.000Z") }))).toBe(
            "queued",
        );
        expect(
            getPhase(
                deployment({
                    queuedAt: new Date("2026-08-19T12:01:00.000Z"),
                    startedAt: new Date("2026-08-19T12:02:00.000Z"),
                }),
            ),
        ).toBe("started");
        expect(
            getPhase(
                deployment({
                    finishedAt: new Date("2026-08-19T12:03:00.000Z"),
                    queuedAt: new Date("2026-08-19T12:01:00.000Z"),
                    startedAt: new Date("2026-08-19T12:02:00.000Z"),
                }),
            ),
        ).toBe("finished");
    });
});

describe("getDisplayStatus", () => {
    it("prefers cancelled and failed outcomes", () => {
        expect(getDisplayStatus(deployment({ outcome: "cancelled" }))).toBe("cancelled");
        expect(getDisplayStatus(deployment({ outcome: "failed" }))).toBe("failed");
    });

    it("marks a finished deployment as deployed", () => {
        expect(
            getDisplayStatus(deployment({ finishedAt: new Date("2026-08-19T12:03:00.000Z") })),
        ).toBe("deployed");
    });

    it("marks a selected deployment as failed when logs match a failure", () => {
        expect(
            getDisplayStatus(deployment({ startedAt: new Date("2026-08-19T12:02:00.000Z") }), [
                { message: "Deploy error: boom", stream: "stderr" },
            ]),
        ).toBe("failed");
    });
});

describe("isDeploymentActive", () => {
    it("is active while started without a failure", () => {
        expect(
            isDeploymentActive(deployment({ startedAt: new Date("2026-08-19T12:02:00.000Z") })),
        ).toBe(true);
    });

    it("is inactive once finished or failed", () => {
        expect(
            isDeploymentActive(deployment({ finishedAt: new Date("2026-08-19T12:03:00.000Z") })),
        ).toBe(false);
        expect(isDeploymentActive(deployment({ outcome: "failed" }))).toBe(false);
    });
});

describe("getDuration", () => {
    it("returns null until both start and finish exist", () => {
        expect(
            getDuration(deployment({ startedAt: new Date("2026-08-19T12:02:00.000Z") })),
        ).toBeNull();
    });

    it("formats seconds, minutes, and hours", () => {
        const startedAt = new Date("2026-08-19T12:00:00.000Z");

        expect(
            getDuration(
                deployment({
                    finishedAt: new Date("2026-08-19T12:00:45.000Z"),
                    startedAt,
                }),
            ),
        ).toBe("45s");
        expect(
            getDuration(
                deployment({
                    finishedAt: new Date("2026-08-19T12:01:00.000Z"),
                    startedAt,
                }),
            ),
        ).toBe("1m");
        expect(
            getDuration(
                deployment({
                    finishedAt: new Date("2026-08-19T12:01:30.000Z"),
                    startedAt,
                }),
            ),
        ).toBe("1m 30s");
        expect(
            getDuration(
                deployment({
                    finishedAt: new Date("2026-08-19T13:00:00.000Z"),
                    startedAt,
                }),
            ),
        ).toBe("1h");
        expect(
            getDuration(
                deployment({
                    finishedAt: new Date("2026-08-19T13:01:00.000Z"),
                    startedAt,
                }),
            ),
        ).toBe("1h 1m");
    });
});

describe("getShortId", () => {
    it("keeps the first seven characters", () => {
        expect(getShortId("abcdef1234567890")).toBe("abcdef1");
    });
});
