import { db } from "#lib/db";
import { withKeyedLock } from "#lib/server/shared/locks";

/** Also serialize across app processes; a reserved connection owns the session lock. */
export const withGitSourceLock = async <T>(
    sourceId: string,
    operation: () => Promise<T>,
): Promise<T> =>
    // Bound Git work to one operation per process so reserved locks cannot exhaust the DB pool.
    await withKeyedLock("git-source-operations", async () => {
        const connection = await db.$client.reserve();
        try {
            await connection`select pg_advisory_lock(hashtext('stoat-git-source'), hashtext(${sourceId}))`;
            return await operation();
        } finally {
            try {
                await connection`select pg_advisory_unlock(hashtext('stoat-git-source'), hashtext(${sourceId}))`;
            } finally {
                connection.release();
            }
        }
    });
