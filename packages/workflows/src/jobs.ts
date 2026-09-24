import { Job } from "effect-mq";
import { Schema } from "effect";

const payload = Schema.Struct({
    clusterId: Schema.String,
    // InitializationRequestedAt ISO string. Makes the job id deterministic
    // per request so retries and outbox recovery are idempotent.
    requestId: Schema.String,
});

export const InitializeCluster: Job.Job<
    "InitializeCluster",
    typeof payload,
    Schema.Void,
    Schema.Never
> = Job.make("InitializeCluster", {
    payload,
    success: Schema.Void,
    idempotencyKey: ({ clusterId, requestId }) => `${clusterId}:${requestId}`,
    metadata: ({ clusterId, requestId }) => ({
        clusterId,
        requestId,
    }),
    queue: "initialize",
    defaults: {
        attempts: 5,
        backoff: { type: "exponential", delay: "30 seconds" },
        timeout: "15 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});

const resourcePayload = Schema.Struct({ deploymentId: Schema.String });

export const DeployResource: Job.Job<
    "DeployResource",
    typeof resourcePayload,
    Schema.Void,
    Schema.Never
> = Job.make("DeployResource", {
    payload: resourcePayload,
    success: Schema.Void,
    idempotencyKey: ({ deploymentId }) => deploymentId,
    queue: "deploy",
    defaults: {
        attempts: 5,
        backoff: { type: "exponential", delay: "30 seconds" },
        timeout: "15 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});
