import type { ErrorResponse } from "./types";
import * as z from "zod";

export const errorResponseSchema = z.object({ error: z.string() });

/**
 * Thrown by `unwrap()` and by the streaming helpers when the sidecar returns a
 * non-2xx response.
 *
 * Every error response in the Uncloud spec is `{ error: string }`, so the
 * message is lifted out of the body when present.
 */
export class UcApiError extends Error {
    override readonly name = "UcApiError";
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    /** Parsed `{ error }` body, when the sidecar returned one. */
    readonly body: ErrorResponse | undefined;

    constructor(response: { status: number; statusText: string; url: string }, cause?: unknown) {
        const parsed = errorResponseSchema.safeParse(cause).data;
        super(
            parsed?.error ??
                `Sidecar request failed: ${response.status} ${response.statusText} (${response.url})`,
        );
        this.status = response.status;
        this.statusText = response.statusText;
        this.url = response.url;
        this.body = parsed;
    }
}

/**
 * Turns a client result into a plain value, throwing `UcApiError` on failure.
 *
 * The client returns `{ data, error }` rather than throwing, which is the
 * right default for call sites that want to branch on failure. Use this when you
 * would rather let the error propagate (for example inside an oRPC handler).
 *
 * ```ts
 * const machines = await unwrap(ucClient.GET("/api/v1/machines"));
 * ```
 */
export async function unwrap<T>(
    promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
    const { data, error, response } = await promise;

    if (!response.ok || error !== undefined) {
        throw new UcApiError(response, error);
    }

    // SAFETY: successful results carry the generated operation's payload type T.
    // Empty responses retain the existing SDK behavior of returning undefined.
    return data as T;
}
