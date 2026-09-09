import { count, desc, eq, sql } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, deployments, gitSource, resources, workspace } from "#lib/db/schema";

const RECENT_DEPLOYMENT_LIMIT = 8;

export const getOrganizationOverview = async (organizationId: string) => {
    const [workspaceRows, [dataSourceTotal], latestDeployments, recentDeployments] =
        await Promise.all([
            db
                .select({
                    createdAt: workspace.createdAt,
                    dataSourceId: workspace.dataSourceId,
                    dataSourceLabel: sql<string>`coalesce(${gitSource.name}, ${gitSource.url}, ${dataSource.uncloudUrl})`,
                    id: workspace.id,
                    name: workspace.name,
                    resourceCount: count(resources.id),
                    slug: workspace.slug,
                })
                .from(workspace)
                .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
                .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
                .leftJoin(resources, eq(resources.workspaceId, workspace.id))
                .where(eq(workspace.organizationId, organizationId))
                .groupBy(
                    workspace.id,
                    dataSource.id,
                    dataSource.uncloudUrl,
                    gitSource.id,
                    gitSource.name,
                    gitSource.url,
                )
                .orderBy(desc(workspace.updatedAt)),
            db
                .select({ count: count() })
                .from(dataSource)
                .where(eq(dataSource.organizationId, organizationId)),
            db
                .selectDistinctOn([deployments.resourceId], {
                    finishedAt: deployments.finishedAt,
                    outcome: deployments.outcome,
                    resourceId: deployments.resourceId,
                })
                .from(deployments)
                .innerJoin(resources, eq(resources.id, deployments.resourceId))
                .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
                .where(eq(workspace.organizationId, organizationId))
                .orderBy(deployments.resourceId, desc(deployments.createdAt), desc(deployments.id)),
            db
                .select({
                    createdAt: deployments.createdAt,
                    finishedAt: deployments.finishedAt,
                    id: deployments.id,
                    outcome: deployments.outcome,
                    resourceId: resources.id,
                    resourceName: resources.name,
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                })
                .from(deployments)
                .innerJoin(resources, eq(resources.id, deployments.resourceId))
                .innerJoin(workspace, eq(workspace.id, resources.workspaceId))
                .where(eq(workspace.organizationId, organizationId))
                .orderBy(desc(deployments.createdAt), desc(deployments.id))
                .limit(RECENT_DEPLOYMENT_LIMIT),
        ]);

    const resourceCount = workspaceRows.reduce(
        (total, workspaceRow) => total + workspaceRow.resourceCount,
        0,
    );
    const activeDeploymentCount = latestDeployments.filter(
        (deployment) => deployment.finishedAt === null,
    ).length;
    const failedDeploymentCount = latestDeployments.filter(
        (deployment) => deployment.outcome === "failed",
    ).length;

    return {
        activeDeploymentCount,
        dataSourceCount: dataSourceTotal?.count ?? 0,
        failedDeploymentCount,
        recentDeployments,
        resourceCount,
        workspaces: workspaceRows,
    };
};
