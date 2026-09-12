export interface DeploymentListItem {
    createdAt: Date;
    finishedAt: Date | null;
    gitCommit: string | null;
    id: string;
    jobId: string | null;
    outcome: string | null;
    queuedAt: Date | null;
    resourceId: string;
    resourceName: string | null;
    resourceSlug: string | null;
    startedAt: Date | null;
    updatedAt: Date;
    workspaceId: string;
    workspaceName: string | null;
    workspaceSlug: string;
}
