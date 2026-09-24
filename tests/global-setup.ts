import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vite-plus/test/node";

declare module "vite-plus/test" {
    interface ProvidedContext {
        databaseUrl: string;
    }
}

export default async function setup(project: TestProject) {
    const postgres = await new PostgreSqlContainer("postgres:18-alpine").start();
    project.provide("databaseUrl", postgres.getConnectionUri());

    return async () => {
        await postgres.stop();
    };
}
