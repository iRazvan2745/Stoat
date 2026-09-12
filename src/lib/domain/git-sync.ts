export interface GitResourceSyncState {
    sourceId: string;
    path: string;
    appHash: string;
    repoHash: string;
}

export interface GitSyncResult {
    commit: string | null;
    commits: number;
    deployments: number;
    imported: number;
    updated: number;
    exported: number;
    issues: string[];
    checkedAt: string;
}

const GIT_SYNC_NEEDED_PATTERNS: readonly RegExp[] = [
    /sync before publishing app edits/iu,
    /restore or reconcile it before publishing/iu,
    /both the app and git differ/iu,
    /resource configuration changed during git sync/iu,
    /the resource changed while syncing/iu,
];

/** True when a deployment log line is a Git publish-blocker fixable by syncing. */
export function isGitSyncNeededMessage(message: string): boolean {
    return GIT_SYNC_NEEDED_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when any deployment log shows a Git publish-blocker fixable by syncing. */
export function deploymentNeedsGitSync(
    logs: readonly { message: string }[]
): boolean {
    return logs.some((log) => isGitSyncNeededMessage(log.message));
}
