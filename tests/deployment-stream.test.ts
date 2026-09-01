import { describe, expect, it } from "vite-plus/test";

import { formatDeployStreamEvent } from "#lib/server/deployments/deployment-stream";

describe("formatDeployStreamEvent", () => {
    it("formats a plan as a readable action", () => {
        expect(
            formatDeployStreamEvent("plan", {
                operations: [
                    {
                        action: "run",
                        image: "nginx",
                        machine: "hazel",
                        service: "nginx-f7gzq-nginx",
                    },
                ],
            }),
        ).toEqual({
            isError: false,
            message: "Plan: Start nginx-f7gzq-nginx on machine hazel (image nginx)",
            stream: "stdout",
        });
    });

    it("keeps progress events machine-parseable for the log UI", () => {
        expect(
            formatDeployStreamEvent("progress", {
                id: "Container nginx-f7gzq-nginx-3xhi on hazel",
                phase: "done",
                status: "Running",
            }),
        ).toEqual({
            isError: false,
            message:
                "Progress: Container nginx-f7gzq-nginx-3xhi on hazel phase=done status=Running",
            stream: "stdout",
        });
    });
});
