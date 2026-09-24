/**
 * Minimal Server-Sent Events reader.
 *
 * Four Uncloud endpoints respond with `text/event-stream` rather than JSON:
 * service logs, machine logs, machine exec, and Compose deploys. `ofetch` leaves
 * those response bodies as streams, so they are parsed manually here while still
 * reusing the generated request/event types.
 *
 * `EventSource` is not used because it is GET-only (two of these endpoints are
 * POST with a body), cannot set headers, and auto-reconnects — which would
 * silently replay a deployment.
 */

export type SseMessage = {
    /** `event:` field, if the server sent one. */
    event: string | undefined;
    /** `data:` field(s), joined with newlines per the SSE spec. */
    data: string;
    /** `id:` field, if the server sent one. */
    id: string | undefined;
};

/**
 * Decodes a byte stream into SSE messages.
 *
 * Handles chunk boundaries splitting a line or a multi-byte character, CRLF and
 * LF line endings, multi-line `data:` payloads, and `:` comment/keep-alive lines.
 */
export async function* readSseMessages(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let streamEnded = false;

    let buffer = "";
    let dataLines: string[] = [];
    let eventName: string | undefined;
    let lastId: string | undefined;

    const takeMessage = (): SseMessage | undefined => {
        if (dataLines.length === 0) {
            // A dispatch with no data carries no payload; reset and skip it.
            eventName = undefined;

            return undefined;
        }

        const message: SseMessage = {
            event: eventName,
            data: dataLines.join("\n"),
            id: lastId,
        };

        dataLines = [];
        eventName = undefined;

        return message;
    };

    const handleLine = (rawLine: string): SseMessage | undefined => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        // Blank line terminates the current event.
        if (line === "") {
            return takeMessage();
        }

        // Lines starting with ':' are comments, commonly used as keep-alives.
        if (line.startsWith(":")) {
            return undefined;
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);

        // A single leading space after the colon is part of the framing.
        if (value.startsWith(" ")) {
            value = value.slice(1);
        }

        switch (field) {
            case "data":
                dataLines.push(value);
                break;
            case "event":
                eventName = value;
                break;
            case "id":
                lastId = value;
                break;
            default:
                // 'retry' and unknown fields are ignored: we never reconnect.
                break;
        }

        return undefined;
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                streamEnded = true;
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let newline = buffer.indexOf("\n");

            while (newline !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                const message = handleLine(line);

                if (message) {
                    yield message;
                }

                newline = buffer.indexOf("\n");
            }
        }

        // Flush any trailing bytes and a final event not followed by a blank line.
        buffer += decoder.decode();

        if (buffer !== "") {
            const message = handleLine(buffer);

            if (message) {
                yield message;
            }
        }

        const trailing = takeMessage();

        if (trailing) {
            yield trailing;
        }
    } finally {
        try {
            if (!streamEnded) {
                // Releasing the lock only hands the stream back to its owner; it
                // does not stop an in-flight fetch. Cancel first so early
                // iterator termination closes the underlying request.
                await reader.cancel();
            }
        } catch {
            // Cleanup must not replace a read error (or make iterator.return()
            // reject) when the underlying stream cannot be cancelled.
        } finally {
            reader.releaseLock();
        }
    }
}

/**
 * Decodes an SSE byte stream into typed JSON events.
 *
 * Non-JSON payloads (such as the bare `[DONE]` sentinel some servers emit) are
 * skipped rather than throwing, so a stray frame cannot kill a long-lived log tail.
 */
export async function* readSseJson<T>(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
    for await (const message of readSseMessages(stream)) {
        let parsed: unknown;

        try {
            parsed = JSON.parse(message.data);
        } catch {
            continue;
        }

        // SAFETY: callers select the event contract for their endpoint; this decoder
        // only handles SSE framing and JSON syntax, not application-level validation.
        yield parsed as T;
    }
}
