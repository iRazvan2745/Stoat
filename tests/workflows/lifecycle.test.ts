import { Effect, Layer } from "effect";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createServer } from "vite";
import { monitoringWorker } from "../../apps/web/worker-plugin";
import { startWorker, stopWorker } from "../../packages/workflows/src/lifecycle";

afterEach(async () => {
    await stopWorker();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("runs one worker across reloads and awaits cleanup before allowing a restart", async () => {
    vi.useFakeTimers();
    const started = vi.fn();
    const released = vi.fn();
    const sweep = vi.fn();
    const release = Promise.withResolvers<void>();

    const worker = Layer.launch(
        Layer.effectDiscard(
            Effect.acquireRelease(Effect.sync(started), () =>
                Effect.promise(() => release.promise).pipe(Effect.andThen(Effect.sync(released))),
            ),
        ),
    );

    const listeners = process.listenerCount("sveltekit:shutdown");

    startWorker(worker, Effect.sync(sweep));
    startWorker(worker, Effect.sync(sweep));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("sveltekit:shutdown")).toBe(listeners + 1);

    const stopping = stopWorker();
    startWorker(worker, Effect.sync(sweep));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();

    release.resolve();
    await stopping;
    await stopWorker();
    expect(released).toHaveBeenCalledTimes(1);
    expect(globalThis.__stoatWorker).toBeUndefined();
    expect(process.listenerCount("sveltekit:shutdown")).toBe(listeners);
    expect(vi.getTimerCount()).toBe(0);

    startWorker(worker, Effect.sync(sweep));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledTimes(2);
});

it("does not overlap slow sweeps and interrupts an active sweep on shutdown", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();

    const sweep = vi.fn((signal: AbortSignal) => {
        signal.addEventListener("abort", aborted, { once: true });

        return new Promise<void>(() => {});
    });

    startWorker(Effect.never, Effect.promise(sweep));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    await stopWorker();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

it("retries failed sweeps and restarts both loops after a worker failure", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = vi.fn();
    const released = vi.fn();

    const sweep = vi.fn(() => {
        throw new Error("outbox unavailable");
    });

    startWorker(
        Layer.launch(
            Layer.effectDiscard(
                Effect.gen(function* () {
                    yield* Effect.acquireRelease(Effect.sync(started), () => Effect.sync(released));

                    if (started.mock.calls.length === 1) {
                        yield* Effect.sleep("6 seconds");
                        yield* Effect.die(new Error("worker failed"));
                    }
                }),
            ),
        ),
        Effect.sync(sweep),
    );
    await vi.advanceTimersByTimeAsync(5_001);
    expect(sweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(released).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(globalThis.__stoatWorker).toBeDefined();

    await stopWorker();
    expect(released).toHaveBeenCalledTimes(2);
    expect(globalThis.__stoatWorker).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending worker restart on shutdown", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const started = vi.fn(() => {
        throw new Error("queue tables unavailable");
    });

    startWorker(Effect.sync(started), Effect.void);
    await vi.advanceTimersByTimeAsync(0);
    await stopWorker();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toHaveBeenCalledTimes(1);
    expect(globalThis.__stoatWorker).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
});

it("stops on adapter-node shutdown without logging interruption as a failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    startWorker(Effect.never, Effect.never);
    process.emit("sveltekit:shutdown", "SIGTERM");
    await stopWorker();
    expect(globalThis.__stoatWorker).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
});

it("stops the worker before Vite tears down its module runner on restart and close", async () => {
    const server = await createServer({
        configFile: false,
        plugins: [monitoringWorker()],
        server: { middlewareMode: true, watch: null },
        logLevel: "silent",
    });

    const released = vi.fn();
    const acquired = Promise.withResolvers<void>();

    try {
        // Create the same SSR compatibility runner used by SvelteKit.
        await server.ssrLoadModule("/packages/workflows/src/lifecycle.ts");

        const worker = Layer.launch(
            Layer.effectDiscard(
                Effect.acquireRelease(
                    Effect.sync(() => acquired.resolve()),
                    () =>
                        Effect.promise(async () => {
                            await server.ssrLoadModule("/packages/workflows/src/lifecycle.ts");
                            released();
                        }),
                ),
            ),
        );

        startWorker(worker, Effect.void);
        await acquired.promise;
        await server.restart();
        expect(released).toHaveBeenCalledTimes(1);
        expect(globalThis.__stoatWorker).toBeUndefined();

        startWorker(worker, Effect.void);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await server.close();
        expect(released).toHaveBeenCalledTimes(2);
        expect(globalThis.__stoatWorker).toBeUndefined();
    } finally {
        await server.close();
    }
});
