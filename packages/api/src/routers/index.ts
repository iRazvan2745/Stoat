import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";

import { clusterRouter } from "./cluster";

import { projectsRouter } from "./projects";
import { resourcesRouter } from "./resources";
import { connectionsRouter } from "./connections";

export const appRouter = {
    cluster: clusterRouter,
    projects: projectsRouter,
    resources: resourcesRouter,
    connections: connectionsRouter,
    healthCheck: publicProcedure.handler(() => {
        return "OK";
    }),
    privateData: protectedProcedure.handler(({ context }) => {
        return {
            message: "This is private",
            user: context.session?.user,
        };
    }),
};

export type AppRouter = typeof appRouter;

export type AppRouterClient = RouterClient<typeof appRouter>;
