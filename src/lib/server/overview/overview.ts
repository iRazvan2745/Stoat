import { count, desc, eq, sql } from "drizzle-orm";

import { db } from "#lib/db";
import { dataSource, deployments, gitSource, services, workspace } from "#lib/db/schema";

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
                    serviceCount: count(services.id),
                    slug: workspace.slug,
                })
                .from(workspace)
                .innerJoin(dataSource, eq(dataSource.id, workspace.dataSourceId))
                .innerJoin(gitSource, eq(gitSource.id, dataSource.gitSourceId))
                .leftJoin(services, eq(services.workspaceId, workspace.id))
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
                .selectDistinctOn([deployments.serviceId], {
                    finishedAt: deployments.finishedAt,
                    outcome: deployments.outcome,
                    serviceId: deployments.serviceId,
                })
                .from(deployments)
                .innerJoin(services, eq(services.id, deployments.serviceId))
                .innerJoin(workspace, eq(workspace.id, services.workspaceId))
                .where(eq(workspace.organizationId, organizationId))
                .orderBy(deployments.serviceId, desc(deployments.createdAt), desc(deployments.id)),
            db
                .select({
                    createdAt: deployments.createdAt,
                    finishedAt: deployments.finishedAt,
                    id: deployments.id,
                    outcome: deployments.outcome,
                    serviceId: services.id,
                    serviceName: services.name,
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                })
                .from(deployments)
                .innerJoin(services, eq(services.id, deployments.serviceId))
                .innerJoin(workspace, eq(workspace.id, services.workspaceId))
                .where(eq(workspace.organizationId, organizationId))
                .orderBy(desc(deployments.createdAt), desc(deployments.id))
                .limit(RECENT_DEPLOYMENT_LIMIT),
        ]);

    const serviceCount = workspaceRows.reduce(
        (total, workspaceRow) => total + workspaceRow.serviceCount,
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
        serviceCount,
        workspaces: workspaceRows,
    };
};
