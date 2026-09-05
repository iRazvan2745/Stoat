// oxlint-disable no-await-in-loop
import { eq } from "drizzle-orm";
import { log as evlog } from "evlog";

import { db } from "#lib/db";
import { gitSource } from "#lib/db/schema";
import { syncGitSource } from "#lib/server/git-sources/sync";

const SYNC_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let disposed = false;

const pollGitSources = async (): Promise<void> => {
    try {
        const sources = await db
            .select({ id: gitSource.id })
            .from(gitSource)
            .where(eq(gitSource.syncEnabled, true));
        for (const source of sources) {
            if (disposed) return;
            try {
                await syncGitSource(source.id);
            } catch {
                evlog.error({ action: "git.sync_failed", gitSourceId: source.id });
            }
        }
    } catch {
        evlog.error({ action: "git.sync_poll_failed" });
    } finally {
        if (!disposed) {
            timer = setTimeout(() => {
                void pollGitSources();
            }, SYNC_INTERVAL_MS);
            timer.unref();
        }
    }
};

export const ensureGitSyncWorker = (): void => {
    if (started) return;
    started = true;
    void pollGitSources();
};

const { hot } = import.meta as { hot?: { dispose: (callback: () => void) => void } };
hot?.dispose(() => {
    disposed = true;
    clearTimeout(timer);
});
