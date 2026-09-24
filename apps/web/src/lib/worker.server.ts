import { startWorker } from "@stoat/workflows/lifecycle";
import { MonitoringWorkerLive, pollInitializationOutbox } from "@stoat/workflows/runtime";
import { JobStoreLive } from "@stoat/workflows/store";
import { Effect, Layer } from "effect";

function requireEnv(name: string) {
    const value = process.env[name];

    if (!value) throw new Error(`[worker] ${name} is required for cluster initialization.`);

    return value;
}

/**
 * Run the cluster-monitoring worker inside the web server process.
 *
 * Call once at server startup (never during `vite build`). The queue itself
 * lives in Postgres via effect-mq, so jobs survive web restarts: an
 * in-flight job is reclaimed by the stall sweeper and the outbox sweep
 * re-enqueues anything committed while the queue was unreachable.
 *
 * NOTE: this requires a long-lived Node server (adapter-node). Moving to a
 * serverless adapter means moving this back out into a dedicated process.
 */
export function startMonitoringWorker() {
    requireEnv("DATABASE_URL");
    const secret = requireEnv("BETTER_AUTH_SECRET");

    if (secret.length < 32) {
        throw new Error("[worker] BETTER_AUTH_SECRET must contain at least 32 characters.");
    }

    startWorker(
        Layer.launch(MonitoringWorkerLive),
        pollInitializationOutbox().pipe(Effect.provide(JobStoreLive)),
    );
}
