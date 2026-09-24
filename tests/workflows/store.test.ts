import { Effect, Layer } from "effect";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { PgLive } from "../../packages/workflows/src/store";

afterEach(() => vi.unstubAllEnvs());

it("defers DATABASE_URL validation until the database layer is built", async () => {
    vi.stubEnv("DATABASE_URL", "");

    await expect(Effect.runPromise(Layer.build(PgLive).pipe(Effect.scoped))).rejects.toThrow(
        "DATABASE_URL is required for the workflow queue.",
    );
});
