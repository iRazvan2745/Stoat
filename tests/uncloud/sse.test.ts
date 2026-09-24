import { describe, expect, it } from "vite-plus/test";

import { readSseJson, readSseMessages } from "../../packages/uncloud/src/sse";

/** Builds a byte stream, optionally split at arbitrary points to mimic network chunking. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }

            controller.close();
        },
    });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];

    for await (const item of iterable) {
        out.push(item);
    }

    return out;
}

describe("readSseMessages", () => {
    it("parses consecutive events", async () => {
        const messages = await collect(readSseMessages(streamOf("data: one\n\ndata: two\n\n")));
        expect(messages.map((m) => m.data)).toEqual(["one", "two"]);
    });

    it("reassembles events split across chunk boundaries", async () => {
        const messages = await collect(
            readSseMessages(streamOf("data: hel", "lo wor", "ld\n", "\ndata: second\n\n")),
        );

        expect(messages.map((m) => m.data)).toEqual(["hello world", "second"]);
    });

    it("handles a multi-byte character split across chunks", async () => {
        const encoder = new TextEncoder();
        const bytes = encoder.encode("data: héllo\n\n");
        const split = 8; // lands inside the two-byte 'é'

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, split));
                controller.enqueue(bytes.slice(split));
                controller.close();
            },
        });

        const messages = await collect(readSseMessages(stream));
        expect(messages[0]?.data).toBe("héllo");
    });

    it("joins multi-line data payloads with newlines", async () => {
        const messages = await collect(readSseMessages(streamOf("data: a\ndata: b\n\n")));
        expect(messages[0]?.data).toBe("a\nb");
    });

    it("supports CRLF line endings", async () => {
        const messages = await collect(readSseMessages(streamOf("data: one\r\n\r\n")));
        expect(messages[0]?.data).toBe("one");
    });

    it("ignores comment keep-alive lines", async () => {
        const messages = await collect(readSseMessages(streamOf(": keep-alive\n\ndata: real\n\n")));
        expect(messages.map((m) => m.data)).toEqual(["real"]);
    });

    it("captures event and id fields", async () => {
        const messages = await collect(
            readSseMessages(streamOf("event: progress\nid: 42\ndata: {}\n\n")),
        );

        expect(messages[0]).toMatchObject({ event: "progress", id: "42", data: "{}" });
    });

    it("preserves data containing colons and strips only one leading space", async () => {
        const messages = await collect(readSseMessages(streamOf('data:  {"url":"http://x"}\n\n')));
        expect(messages[0]?.data).toBe(' {"url":"http://x"}');
    });

    it("emits a trailing event not terminated by a blank line", async () => {
        const messages = await collect(readSseMessages(streamOf("data: last\n")));
        expect(messages.map((m) => m.data)).toEqual(["last"]);
    });

    it("yields nothing for an empty stream", async () => {
        expect(await collect(readSseMessages(streamOf()))).toEqual([]);
    });

    it("cancels the underlying stream when iteration stops early", async () => {
        const encoder = new TextEncoder();
        let cancelled = false;

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: first\n\n"));
            },
            cancel() {
                cancelled = true;
            },
        });

        const iterator = readSseMessages(stream);

        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(first.value?.data).toBe("first");

        await iterator.return();

        expect(cancelled).toBe(true);
        const reader = stream.getReader();
        expect((await reader.read()).done).toBe(true);
        reader.releaseLock();
    });
});

describe("readSseJson", () => {
    it("decodes typed JSON events", async () => {
        const events = await collect(
            readSseJson<{ n: number }>(streamOf('data: {"n":1}\n\ndata: {"n":2}\n\n')),
        );

        expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("skips non-JSON frames instead of throwing", async () => {
        const events = await collect(
            readSseJson<{ n: number }>(
                streamOf('data: {"n":1}\n\ndata: [DONE]\n\ndata: {"n":2}\n\n'),
            ),
        );

        expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    });
});
