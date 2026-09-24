import {
    mqDedupe,
    mqFlowChildren,
    mqFlowOutbox,
    mqJobAttempts,
    mqJobs,
    mqQueueControl,
    mqSchedules,
} from "effect-mq/drizzle-postgres";

// The name column is typed to this union so a typo in queries is a compile error.
// NOTE: Explicit `any` annotations keep `tsc -b` declaration emit portable
// (TS2883) while the SQL layout stays owned by the factories below.
export type MonitoringJobNames = "InitializeCluster" | "DeployResource";

export const jobs: any = mqJobs<MonitoringJobNames>();

export const jobAttempts: any = mqJobAttempts(jobs);

export const jobSchedules: any = mqSchedules<MonitoringJobNames>();

export const jobQueues: any = mqQueueControl();

export const jobDedupe: any = mqDedupe<MonitoringJobNames>();

export const jobFlowChildren: any = mqFlowChildren();

export const jobFlowOutbox: any = mqFlowOutbox();
