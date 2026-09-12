import { GitSyncError } from "#lib/server/git-sources/errors";

/** Invalid repository configuration can produce a failed deployment without stopping later commits. */
export class GitComposeError extends GitSyncError {
    override readonly name = "GitComposeError";
}
