export const UNCLOUD_REQUEST_TIMEOUT_MS = 5000;

export async function fetchUncloud(
    request: Request,
    timeoutMs = UNCLOUD_REQUEST_TIMEOUT_MS,
): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);

    try {
        return await fetch(request, { signal });
    } catch (error) {
        if (timeout.aborted && !request.signal.aborted) {
            throw new Error("Uncloud API timed out.", { cause: error });
        }

        throw error;
    }
}

/**
 * Like fetchUncloud, but the timeout only covers waiting for response headers.
 * Once the response arrives the timer is cleared, so long-lived streaming
 * bodies (deploy progress, logs) are never aborted by the timeout. The
 * request's own signal still cancels the stream at any point.
 */
export async function fetchUncloudStream(
    request: Request,
    headersTimeoutMs = UNCLOUD_REQUEST_TIMEOUT_MS,
): Promise<Response> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), headersTimeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutController.signal]);

    try {
        return await fetch(request, { signal });
    } catch (error) {
        if (timeoutController.signal.aborted && !request.signal.aborted) {
            throw new Error("Uncloud API timed out.", { cause: error });
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}
