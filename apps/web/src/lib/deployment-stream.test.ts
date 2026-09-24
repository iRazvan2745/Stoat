import { ORPCError } from "@orpc/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { subscribeToStream } from "./deployment-stream";

afterEach(() => vi.useRealTimers());

it("reconnects with the consumed cursor only after transport failure, not completion", async () => {
    vi.useFakeTimers();
    let cursor = 0;
    const events: number[] = [];

    const connect = vi.fn(async () =>
        (async function* () {
            if (cursor === 0) {
                yield 1;
                throw new TypeError("Network disconnected");
            }

            expect(cursor).toBe(1);
            yield 2;
        })(),
    );

    const error = vi.fn();

    const stop = subscribeToStream(
        connect,
        (event) => {
            cursor = event;
            events.push(event);
        },
        error,
        () => cursor === 2,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(expect.any(TypeError), true);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(connect).toHaveBeenCalledTimes(2);
    stop();
});

it("reconnects after an unexpected clean EOF", async () => {
    vi.useFakeTimers();

    const connect = vi.fn(async () =>
        (async function* () {
            yield 1;
        })(),
    );

    const onError = vi.fn();
    const stop = subscribeToStream(connect, vi.fn(), onError);
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Live stream ended unexpectedly." }),
        true,
    );
    stop();
});

it("aborts an open stream, ignores late events, and cancels scheduled reconnects", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let release = () => {};

    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });

    const connect = vi.fn(async (current: AbortSignal) => {
        signal = current;

        return (async function* () {
            await waiting;
            yield 1;
        })();
    });

    const event = vi.fn();
    const stop = subscribeToStream(connect, event, vi.fn());
    stop();
    expect(signal?.aborted).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(10000);
    expect(event).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async (): Promise<AsyncIterable<number>> => {
        throw new TypeError("Offline");
    });

    const stopRetry = subscribeToStream(failing, event, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    stopRetry();
    await vi.advanceTimersByTimeAsync(10000);
    expect(failing).toHaveBeenCalledTimes(1);
});

it("does not retry API errors but does retry a proxy transport failure", async () => {
    vi.useFakeTimers();

    for (const code of [
        "NOT_FOUND",
        "UNAUTHORIZED",
        "FORBIDDEN",
        "INTERNAL_SERVER_ERROR",
        "BAD_GATEWAY",
    ] as const) {
        const error = new ORPCError(code);

        const connect = vi.fn(async (): Promise<AsyncIterable<never>> => {
            throw error;
        });

        const onError = vi.fn();
        const stop = subscribeToStream(connect, vi.fn(), onError);
        await vi.advanceTimersByTimeAsync(10000);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(error, false);
        stop();
    }

    const connect = vi.fn(async (): Promise<AsyncIterable<never>> => {
        throw new ORPCError("MALFORMED_ORPC_RESPONSE", { data: { status: 502 } });
    });

    const stop = subscribeToStream(connect, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(2);
    stop();
});

it("does not reconnect when the event consumer fails or closes from the error callback", async () => {
    vi.useFakeTimers();

    const connect = vi.fn(async () =>
        (async function* () {
            yield 1;
        })(),
    );

    const error = new TypeError("Rendering failed");
    const onError = vi.fn();

    const stop = subscribeToStream(
        connect,
        () => {
            throw error;
        },
        onError,
    );

    await vi.advanceTimersByTimeAsync(10000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, false);
    stop();

    const failing = vi.fn(async (): Promise<AsyncIterable<never>> => {
        throw new TypeError("Offline");
    });

    const stopOnError = subscribeToStream(failing, vi.fn(), () => stopOnError());
    await vi.advanceTimersByTimeAsync(10000);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

it("retries opted-in log discovery failures but still stops on revoked access", async () => {
    vi.useFakeTimers();
    const gateway = new ORPCError("BAD_GATEWAY");
    const forbidden = new ORPCError("FORBIDDEN");
    const connect = vi.fn(async (): Promise<AsyncIterable<never>> => { throw gateway; });
    const onError = vi.fn();
    const stop = subscribeToStream(connect, vi.fn(), onError, () => false, ["BAD_GATEWAY"]);

    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(onError).toHaveBeenLastCalledWith(gateway, true);
        connect.mockImplementationOnce(async () => { throw forbidden; });
        await vi.advanceTimersByTimeAsync(2000);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenLastCalledWith(forbidden, false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(connect).toHaveBeenCalledTimes(2);
    } finally {
        stop();
    }
});
