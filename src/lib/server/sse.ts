// oxlint-disable func-style no-await-in-loop
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  // Fetch bodies reject cancel() with AbortError once the request is aborted.
  // That rejection is a separate promise from reader.read(), so it must be
  // swallowed here or Node treats it as fatal.
  void reader.cancel().catch(() => undefined);
};

export async function consumeSseJsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventName: string, payload: unknown) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const abort = (): void => {
    cancelReader(reader);
  };

  if (signal?.aborted) {
    cancelReader(reader);
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  const flushEvent = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const payloadText = dataLines.join("\n");
    eventName = eventName || "message";
    dataLines = [];

    let payload: unknown;

    try {
      payload = JSON.parse(payloadText);
    } catch {
      eventName = "message";
      return;
    }

    await onEvent(eventName, payload);
    eventName = "message";
  };

  try {
    while (!signal?.aborted) {
      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        throw error;
      }

      const { done, value } = chunk;
      buffer += decoder.decode(value, { stream: !done });

      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.length === 0) {
          await flushEvent();
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (done) {
        break;
      }
    }

    if (signal?.aborted) {
      return;
    }

    if (buffer.length > 0 && buffer.startsWith("data:")) {
      dataLines.push(buffer.slice("data:".length).trim());
    }

    if (dataLines.length > 0) {
      await flushEvent();
    }
  } finally {
    signal?.removeEventListener("abort", abort);

    try {
      reader.releaseLock();
    } catch {
      // The reader is already released after cancel or a completed stream.
    }
  }
}
