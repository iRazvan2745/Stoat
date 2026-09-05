/**
 * The queue's states, leases, and heartbeats own liveness; log silence says
 * nothing about health. Active jobs stay owned by effect-mq until its stalled
 * worker heartbeat recovery transitions them to a durable terminal state.
 */
export const deploymentRecoveryReason = (
    queueState: string | undefined,
    createdAt: Date,
    now: number,
): string | undefined => {
    if (queueState === "failed" || queueState === "cancelled" || queueState === "completed") {
        return `Deployment worker exited with queue state ${queueState} without recording a result`;
    }
    // Allow time between creating the deployment and enqueueing its durable job.
    if (queueState === undefined && now - createdAt.getTime() > 10 * 60 * 1000) {
        return "Deployment has no durable queue job; enqueue a new deployment";
    }
    return undefined;
};
