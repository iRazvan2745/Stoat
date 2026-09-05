/** Only these deliberately written messages are safe to return in sync status. */
export class GitSyncError extends Error {}

/** Invalid repository configuration can produce a failed deployment without stopping later commits. */
export class GitComposeError extends GitSyncError {}
