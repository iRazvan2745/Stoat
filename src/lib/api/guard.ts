import { getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { db } from "#lib/db";
import { deployments } from "#lib/db/schema";
import {
    hasAccessToThisDataSource,
    hasAccessToThisService,
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

const requireResourceAccess = async (
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
    requireResourceAccess(dataSourceId, hasAccessToThisDataSource);

export const requireWorkspaceAccess = (workspaceId: string): Promise<AuthenticatedSession> =>
    requireResourceAccess(workspaceId, hasAccessToThisWorkspace);

export const requireServiceAccess = (serviceId: string): Promise<AuthenticatedSession> =>
    requireResourceAccess(serviceId, hasAccessToThisService);

export const requireDeploymentAccess = async (
    deploymentId: string,
): Promise<AuthenticatedSession> => {
    const session = requireSession();
    const [deployment] = await db
        .select({ serviceId: deployments.serviceId })
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

    if (!deployment) {
        error(404, "Deployment not found");
    }

    if (!(await hasAccessToThisService(session.user.id, deployment.serviceId))) {
        error(403, "Forbidden");
    }

    return session;
};
