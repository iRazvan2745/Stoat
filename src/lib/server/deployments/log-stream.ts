// oxlint-disable no-await-in-loop
import { setTimeout as wait } from "node:timers/promises";

export const DEPLOYMENT_LOG_BATCH_SIZE = 500;

export interface DeploymentLogBatch<Log extends { id: number }> {
    done: boolean;
    hasMore: boolean;
    logs: Log[];
    nextCursor: number;
}

/** Build the cursor response shared by paginated log readers. */
export const createDeploymentLogBatch = <Log extends { id: number }>(
    logs: Log[],
    afterId: number,
    terminal: boolean,
): DeploymentLogBatch<Log> => ({
    done: terminal && logs.length < DEPLOYMENT_LOG_BATCH_SIZE,
    hasMore: logs.length === DEPLOYMENT_LOG_BATCH_SIZE,
    logs,
    nextCursor: logs.at(-1)?.id ?? afterId,
});

interface LogStreamSource<Log extends { id: number }> {
    isTerminal: () => Promise<boolean>;
    read: (afterId: number, limit: number) => Promise<Log[]>;
    signal: AbortSignal;
}

// Read terminal state before draining so the final transaction logs are visible.
export const streamLogBatches = async function* streamLogBatches<Log extends { id: number }>({
    isTerminal,
    read,
    signal,
}: LogStreamSource<Log>): AsyncGenerator<Log[]> {
    let lastId = 0;
    let emitted = false;

    while (!signal.aborted) {
        const terminal = await isTerminal();
        const batch = await read(lastId, DEPLOYMENT_LOG_BATCH_SIZE);

        if (signal.aborted) {
            return;
        }

        if (batch.length > 0 || !emitted) {
            lastId = batch.at(-1)?.id ?? lastId;
            emitted = true;
            yield batch;
        }

        if (batch.length === DEPLOYMENT_LOG_BATCH_SIZE) {
            continue;
        }

        if (terminal) {
            return;
        }

        try {
            await wait(1000, undefined, { signal });
        } catch (error) {
            if (!signal.aborted) {
                throw error;
            }
        }
    }
};
