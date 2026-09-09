import { expect, it, vi } from "vite-plus/test";

import { consumeSseJsonStream } from "../src/lib/server/shared/sse";

const encoder = new TextEncoder();

it("cancels the upstream stream and releases its lock when the consumer fails", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
        cancel,
        start(controller) {
            controller.enqueue(encoder.encode('event: log\ndata: {"message":"hello"}\n\n'));
        },
    });
    const failure = new Error("Consumer failed");

    await expect(
        consumeSseJsonStream(body, () => {
            throw failure;
        }),
    ).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
});

it("preserves the consumer error when upstream cancellation also fails", async () => {
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            throw new Error("Cancellation failed");
        },
        start(controller) {
            controller.enqueue(encoder.encode('data: {"message":"hello"}\n\n'));
        },
    });

    await expect(
        consumeSseJsonStream(body, () => {
            throw new Error("Consumer failed");
        }),
    ).rejects.toThrow("Consumer failed");
    expect(body.locked).toBe(false);
});

it("aborts a pending read and cancels its upstream stream", async () => {
    const abortController = new AbortController();
    const cancel = vi.fn();
    const onEvent = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const consumption = consumeSseJsonStream(body, onEvent, abortController.signal);

    abortController.abort();

    await consumption;
    expect(cancel).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
});

it("consumes fragmented events and a final unterminated event before releasing the stream", async () => {
    const onEvent = vi.fn();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('event: log\r\ndata: {"message":'));
            controller.enqueue(encoder.encode('"hello"}\r\n\r\ndata: {"done":true}'));
            controller.close();
        },
    });

    await consumeSseJsonStream(body, onEvent);

    expect(onEvent.mock.calls).toEqual([
        ["log", { message: "hello" }],
        ["message", { done: true }],
    ]);
    expect(body.locked).toBe(false);
});
