// oxlint-disable func-style no-await-in-loop
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

type SseEventHandler = (eventName: string, payload: unknown) => Promise<void> | void;

interface SseParseState {
  dataLines: string[];
  eventName: string;
}

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // Fetch bodies reject cancel() with AbortError once the request is aborted.
    // That rejection is a separate promise from reader.read(), so it must be
    // swallowed here or Node treats it as fatal.
  }
};

const flushEvent = async (state: SseParseState, onEvent: SseEventHandler): Promise<void> => {
  if (state.dataLines.length === 0) {
    state.eventName = "message";
    return;
  }

  const payloadText = state.dataLines.join("\n");
  state.eventName ||= "message";
  state.dataLines = [];

  let payload: unknown;

  try {
    payload = JSON.parse(payloadText);
  } catch {
    state.eventName = "message";
    return;
  }

  await onEvent(state.eventName, payload);
  state.eventName = "message";
};

const applySseLine = async (
  state: SseParseState,
  line: string,
  onEvent: SseEventHandler,
): Promise<void> => {
  if (line.length === 0) {
    await flushEvent(state, onEvent);
    return;
  }

  if (line.startsWith(":")) {
    return;
  }

  if (line.startsWith("event:")) {
    state.eventName = line.slice("event:".length).trim();
    return;
  }

  if (line.startsWith("data:")) {
    state.dataLines.push(line.slice("data:".length).trim());
  }
};

const readChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> => {
  try {
    return await reader.read();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      return undefined;
    }

    throw error;
  }
};

export async function consumeSseJsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SseEventHandler,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: SseParseState = {
    dataLines: [],
    eventName: "message",
  };
  let buffer = "";
  let shouldContinue = true;

  const abort = (): void => {
    void cancelReader(reader);
  };

  if (signal?.aborted) {
    void cancelReader(reader);
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  try {
    while (shouldContinue) {
      if (signal?.aborted) {
        return;
      }

      const chunk = await readChunk(reader, signal);

      if (!chunk) {
        return;
      }

      const { done, value } = chunk;
      buffer += decoder.decode(value, { stream: !done });

      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await applySseLine(state, line, onEvent);
      }

      shouldContinue = !done;
    }

    if (signal?.aborted) {
      return;
    }

    if (buffer.length > 0 && buffer.startsWith("data:")) {
      state.dataLines.push(buffer.slice("data:".length).trim());
    }

    if (state.dataLines.length > 0) {
      await flushEvent(state, onEvent);
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
