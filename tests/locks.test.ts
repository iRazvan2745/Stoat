import { describe, expect, it } from "vite-plus/test";

import { withKeyedLock } from "#lib/server/shared/locks";

describe("withKeyedLock", () => {
  it("serializes work for the same key", async () => {
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withKeyedLock("same", async () => {
      order.push(1);
      await firstGate;
      order.push(2);
    });
    const second = withKeyedLock("same", async () => {
      order.push(3);
    });

    await Promise.resolve();
    expect(order).toEqual([1]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs different keys concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let otherStarted = false;

    const held = withKeyedLock("a", async () => {
      await gate;
    });
    const other = withKeyedLock("b", async () => {
      otherStarted = true;
    });

    await Promise.resolve();
    expect(otherStarted).toBe(true);

    release();
    await Promise.all([held, other]);
  });
});
