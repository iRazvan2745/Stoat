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

type Session = NonNullable<App.Locals["session"]>;

// Session is resolved once per request in hooks.server.ts; remote functions
// only need to assert it exists.
export const requireSession = (): Session => {
  const { locals } = getRequestEvent();

  if (!locals.session) {
    error(401, "Unauthorized");
  }

  return locals.session;
};

export const requireDataSourceAccess = async (dataSourceId: string): Promise<Session> => {
  const session = requireSession();

  if (!(await hasAccessToThisDataSource(session.user.id, dataSourceId))) {
    error(403, "Forbidden");
  }

  return session;
};

export const requireWorkspaceAccess = async (workspaceId: string): Promise<Session> => {
  const session = requireSession();

  if (!(await hasAccessToThisWorkspace(session.user.id, workspaceId))) {
    error(403, "Forbidden");
  }

  return session;
};

export const requireServiceAccess = async (serviceId: string): Promise<Session> => {
  const session = requireSession();

  if (!(await hasAccessToThisService(session.user.id, serviceId))) {
    error(403, "Forbidden");
  }

  return session;
};

export const requireDeploymentAccess = async (deploymentId: string): Promise<Session> => {
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
