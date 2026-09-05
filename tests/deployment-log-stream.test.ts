// oxlint-disable require-await
import { describe, expect, it, vi } from "vite-plus/test";

import {
    createDeploymentLogBatch,
    DEPLOYMENT_LOG_BATCH_SIZE,
    streamLogBatches,
} from "../src/lib/server/deployments/log-stream";

it("builds a bounded cursor response for the paginated remote query", () => {
    const logs = Array.from({ length: DEPLOYMENT_LOG_BATCH_SIZE }, (_, index) => ({
        id: index + 11,
    }));

    expect(createDeploymentLogBatch(logs, 10, true)).toEqual({
        done: false,
        hasMore: true,
        logs,
        nextCursor: 510,
    });
    expect(createDeploymentLogBatch([{ id: 511 }], 510, true)).toEqual({
        done: true,
        hasMore: false,
        logs: [{ id: 511 }],
        nextCursor: 511,
    });
});

describe("deployment log batches", () => {
    it("drains terminal history in bounded cursor batches without polling again", async () => {
        const records = Array.from({ length: DEPLOYMENT_LOG_BATCH_SIZE * 2 + 1 }, (_, index) => ({
            id: index + 1,
        }));
        const read = vi.fn(async (afterId: number, limit: number) =>
            records.filter((record) => record.id > afterId).slice(0, limit),
        );
        const batches = [];
        for await (const batch of streamLogBatches({
            isTerminal: async () => true,
            read,
            signal: new AbortController().signal,
        })) {
            batches.push(batch);
        }
        expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
        expect(batches.flat()).toEqual(records);
        expect(read.mock.calls).toEqual([
            [0, 500],
            [500, 500],
            [1000, 500],
        ]);
    });

    it("reads terminal state before fetching the final logs", async () => {
        const records: { id: number }[] = [];
        const batches = [];
        for await (const batch of streamLogBatches({
            isTerminal: async () => {
                records.push({ id: 1 });
                return true;
            },
            read: async () => records,
            signal: new AbortController().signal,
        })) {
            batches.push(batch);
        }
        expect(batches).toEqual([[{ id: 1 }]]);
    });

    it("emits empty history and stops for a finished deployment", async () => {
        const stream = streamLogBatches({
            isTerminal: async () => true,
            read: async () => [],
            signal: new AbortController().signal,
        });
        expect(await stream.next()).toEqual({ done: false, value: [] });
        const result = await stream.next();
        expect(result.done).toBe(true);
    });

    it("interrupts a pending poll when the viewer disconnects", async () => {
        const controller = new AbortController();
        const read = vi.fn(async () => []);
        const stream = streamLogBatches({
            isTerminal: async () => false,
            read,
            signal: controller.signal,
        });
        await stream.next();
        const pending = stream.next();
        controller.abort();
        const result = await pending;
        expect(result.done).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
    });
});
