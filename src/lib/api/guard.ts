import { getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { db } from "#lib/db";
import { deployments } from "#lib/db/schema";
import {
    hasAccessToThisDataSource,
    hasAccessToThisGitSource,
    hasAccessToThisResource,
    hasAccessToThisWorkspace,
} from "#lib/server/access";

type AuthenticatedSession = NonNullable<App.Locals["session"]>;
type AccessCheck = (userId: string, resourceId: string) => Promise<boolean>;

// Session is resolved once per request in hooks.server.ts; remote functions
// only need to assert it exists.
export const requireSession = (): AuthenticatedSession => {
    const { locals } = getRequestEvent();

    if (!locals.session) {
        error(401, "Unauthorized");
    }

    return locals.session;
};

const requireAccess = async (
    resourceId: string,
    checkAccess: AccessCheck,
): Promise<AuthenticatedSession> => {
    const session = requireSession();

    if (!(await checkAccess(session.user.id, resourceId))) {
        error(403, "Forbidden");
    }

    return session;
};

export const requireDataSourceAccess = (dataSourceId: string): Promise<AuthenticatedSession> =>
    requireAccess(dataSourceId, hasAccessToThisDataSource);

export const requireGitSourceAccess = (gitSourceId: string): Promise<AuthenticatedSession> =>
    requireAccess(gitSourceId, hasAccessToThisGitSource);

export const requireWorkspaceAccess = (workspaceId: string): Promise<AuthenticatedSession> =>
    requireAccess(workspaceId, hasAccessToThisWorkspace);

export const requireResourceAccess = (resourceId: string): Promise<AuthenticatedSession> =>
    requireAccess(resourceId, hasAccessToThisResource);

export const requireDeploymentAccess = async (
    deploymentId: string,
): Promise<AuthenticatedSession> => {
    const session = requireSession();
    const [deployment] = await db
        .select({ resourceId: deployments.resourceId })
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

    if (!deployment) {
        error(404, "Deployment not found");
    }

    if (!(await hasAccessToThisResource(session.user.id, deployment.resourceId))) {
        error(403, "Forbidden");
    }

    return session;
};
