import { DrizzleJobStore } from "effect-mq/drizzle-postgres";
import type { JobStore } from "effect-mq";
import { PgClient } from "@effect/sql-pg";
import { Layer, Redacted } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
    jobAttempts,
    jobDedupe,
    jobFlowChildren,
    jobFlowOutbox,
    jobQueues,
    jobs,
    jobSchedules,
} from "./schema";

function databaseUrl() {
    const url = process.env.DATABASE_URL;

    if (!url) throw new Error("DATABASE_URL is required for the workflow queue.");

    return url;
}

export const PgLive = Layer.suspend(() => PgClient.layer({ url: Redacted.make(databaseUrl()) }));

export const JobStoreLive: Layer.Layer<JobStore.JobStore, JobStore.JobStoreError | SqlError> =
    DrizzleJobStore.layer({
        jobs,
        attempts: jobAttempts,
        schedules: jobSchedules,
        queues: jobQueues,
        dedupe: jobDedupe,
        flowChildren: jobFlowChildren,
        flowOutbox: jobFlowOutbox,
        historyTtl: {
            completed: "1 day",
            failed: "30 days",
            cancelled: "7 days",
        },
    }).pipe(Layer.provide(PgLive));
