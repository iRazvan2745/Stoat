/** Tail of the pending work chain per key. */
const chains = new Map<string, Promise<void>>();

const cleanupChain = async (key: string, settled: Promise<void>): Promise<void> => {
    await settled;

    if (chains.get(key) === settled) {
        chains.delete(key);
    }
};

/**
 * Runs `fn` exclusively per `key` within this process. Callers with the same
 * key are queued in arrival order; different keys run concurrently.
 */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = (async (): Promise<T> => {
        try {
            await previous;
        } catch {
            // A rejected task must not prevent later tasks from running.
        }

        const result = await fn();
        return result;
    })();
    const settled = (async (): Promise<void> => {
        try {
            await run;
        } catch {
            // Keep the chain settled so the next task can run.
        }
    })();

    chains.set(key, settled);
    void cleanupChain(key, settled);

    return run;
}
