import { describe, expect, it } from "vite-plus/test";

import { withKeyedLock } from "#lib/server/shared/locks";

describe("withKeyedLock", () => {
    it("serializes work for the same key", async () => {
        const order: number[] = [];
        const firstGate = Promise.withResolvers<void>();

        const first = withKeyedLock("same", async () => {
            order.push(1);
            await firstGate.promise;
            order.push(2);
        });
        const second = withKeyedLock("same", () => {
            order.push(3);
            return Promise.resolve();
        });

        await Promise.resolve();
        expect(order).toEqual([1]);

        firstGate.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual([1, 2, 3]);
    });

    it("runs different keys concurrently", async () => {
        const gate = Promise.withResolvers<void>();
        let otherStarted = false;

        const held = withKeyedLock("a", async () => {
            await gate.promise;
        });
        const other = withKeyedLock("b", () => {
            otherStarted = true;
            return Promise.resolve();
        });

        await Promise.resolve();
        expect(otherStarted).toBe(true);

        gate.resolve(undefined);
        await Promise.all([held, other]);
    });
});
