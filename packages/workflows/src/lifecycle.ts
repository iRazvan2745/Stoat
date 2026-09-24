import { Cause, Effect } from "effect";

declare global {
    // Share the stop handle across SvelteKit server-module reloads and Vite's config loader.
    var __stoatWorker: { stop: () => Promise<void> } | undefined;
}

export function startWorker(
    worker: Effect.Effect<never, unknown>,
    pollOutbox: Effect.Effect<unknown, unknown>,
) {
    if (globalThis.__stoatWorker) return;

    const controller = new AbortController();

    const sweep = pollOutbox.pipe(
        Effect.catchCause((cause) =>
            Effect.sync(() => {
                if (!Cause.hasInterruptsOnly(cause)) {
                    console.error("[worker] outbox sweep failed:", Cause.squash(cause));
                }
            }),
        ),
        Effect.andThen(Effect.sleep("5 seconds")),
        Effect.forever,
    );

    const running = {
        stop: () => {
            controller.abort();

            return done;
        },
    };

    globalThis.__stoatWorker = running;
    process.on("sveltekit:shutdown", running.stop);
    console.log("[worker] starting deployment worker (queues: initialize, deploy)");

    // One interruptible parent owns both loops and waits for layer finalizers on shutdown.
    const done = Effect.runPromise(
        Effect.all([worker, sweep], { concurrency: "unbounded", discard: true }).pipe(
            Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);

                console.error("[worker] failed; retrying in 5 seconds:", Cause.squash(cause));

                return Effect.sleep("5 seconds");
            }),
            Effect.forever,
        ),
        { signal: controller.signal },
    )
        .catch((error) => {
            if (!controller.signal.aborted) console.error("[worker] fatal:", error);
        })
        .finally(() => {
            process.off("sveltekit:shutdown", running.stop);

            if (globalThis.__stoatWorker === running) globalThis.__stoatWorker = undefined;
        });
}

export async function stopWorker() {
    await globalThis.__stoatWorker?.stop();
}
