/** Only these deliberately written messages are safe to return in sync status. */
export class GitSyncError extends Error {
    override readonly name: string = "GitSyncError";
}
