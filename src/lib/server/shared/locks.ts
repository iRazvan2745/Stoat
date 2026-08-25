/** Tail of the pending work chain per key. */
const chains = new Map<string, Promise<void>>();

/**
 * Runs `fn` exclusively per `key` within this process. Callers with the same
 * key are queued in arrival order; different keys run concurrently.
 */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );

  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  });

  return run;
}
