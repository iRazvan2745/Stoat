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
