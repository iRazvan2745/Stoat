import { expect, it } from "vite-plus/test";

import { deploymentRecoveryReason } from "#lib/domain/deployments/recovery";

const queuedAt = new Date("2026-01-01T00:00:00Z");
const dayLater = queuedAt.getTime() + 24 * 60 * 60 * 1000;

it("preserves waiting and healthy active jobs regardless of age or log silence", () => {
    for (const state of ["waiting", "delayed", "active", "waiting-children"]) {
        expect(deploymentRecoveryReason(state, queuedAt, dayLater)).toBeUndefined();
    }
});

it("leaves active jobs to the queue heartbeat and stall recovery", () => {
    expect(deploymentRecoveryReason("active", queuedAt, dayLater)).toBeUndefined();
});

it("recovers unfinished records only after the queue has finished their job", () => {
    for (const state of ["failed", "cancelled", "completed"]) {
        expect(deploymentRecoveryReason(state, queuedAt, dayLater)).toContain(state);
    }
});

it("allows enqueue time before recovering a missing job", () => {
    expect(
        deploymentRecoveryReason(undefined, queuedAt, queuedAt.getTime() + 1000),
    ).toBeUndefined();
    expect(deploymentRecoveryReason(undefined, queuedAt, dayLater)).toContain(
        "no durable queue job",
    );
});
