import * as t from "drizzle-orm/pg-core";
import { organization } from "./auth";

export type MonitoringStorage = { type: "volume" | "bind"; source: string };

export type ClusterInitializationConfiguration = {
    machineId: string;
    greptimeStorage: MonitoringStorage;
    alloyStorage: MonitoringStorage;
    retentionDays: number;
};

export const clusters = t.pgTable("clusters", {
    id: t.uuid("id").primaryKey(),
    name: t.text("name").notNull(),
    sidecarUrl: t.text("sidecar_url").notNull(),
    sidecarToken: t.text("sidecar_token").notNull(),
    greptimeUrl: t.text("greptime_url"),
    organizationId: t
        .text("organization_id")
        .notNull()
        .references(() => organization.id, { onDelete: "cascade" }),
    initializedAt: t.timestamp("initialised_at", { withTimezone: true }),
    initializationRequestedAt: t.timestamp("initialization_requested_at", { withTimezone: true }),
    initializationStatus: t.text("initialization_status").notNull().default("uninitialized"),
    initializationError: t.text("initialization_error"),
    initializationConfiguration: t
        .jsonb("initialization_configuration")
        .$type<ClusterInitializationConfiguration>(),
    createdAt: t
        .timestamp("created_at", { withTimezone: true })
        .notNull()
        .$defaultFn(() => new Date()),
    updatedAt: t
        .timestamp("updated_at", { withTimezone: true })
        .notNull()
        .$defaultFn(() => new Date())
        .$onUpdate(() => new Date()),
});

export const projects = t.pgTable("projects", {
    id: t.uuid("id").primaryKey(),
    name: t.text("name").notNull(),
    description: t.text("description"),
    clusterId: t
        .uuid("cluster_id")
        .notNull()
        .references(() => clusters.id, { onDelete: "cascade" }),
    createdAt: t
        .timestamp("created_at", { withTimezone: true })
        .notNull()
        .$defaultFn(() => new Date()),
    isInternal: t.boolean("is_internal").default(false),
    updatedAt: t
        .timestamp("updated_at", { withTimezone: true })
        .notNull()
        .$defaultFn(() => new Date())
        .$onUpdate(() => new Date()),
});

export type GitAccount = { id: string; login: string; name: string | null };

export type GitKnownRepository = { url: string; name: string; defaultBranch: string };

export const gitOAuthProviders = t.pgTable(
    "git_oauth_providers",
    {
        id: t.text("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<"github" | "forgejo">().notNull(),
        serverUrl: t.text("server_url").notNull(),
        clientId: t.text("client_id").notNull(),
        encryptedClientSecret: t.text("encrypted_client_secret").notNull(),
        active: t.boolean("active").notNull().default(true),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("git_oauth_providers_organization_idx").on(table.organizationId)],
);

export const gitConnections = t.pgTable(
    "git_connections",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<"github" | "forgejo" | "generic">().notNull(),
        serverUrl: t.text("server_url").notNull(),
        authType: t.text("auth_type").$type<"token" | "oauth">().notNull().default("token"),
        account: t.jsonb("account").$type<GitAccount>(),
        repositories: t.jsonb("repositories").$type<GitKnownRepository[]>().notNull().default([]),
        encryptedCredentials: t.text("encrypted_credentials"),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("git_connections_organization_idx").on(table.organizationId)],
);

export type ResourceGitSource = {
    repositoryUrl: string;
    branch: string;
    path: string;
    revision: string;
};

export const resources = t.pgTable("resources", {
    id: t.uuid("id").primaryKey(),
    name: t.text("name").notNull(),
    description: t.text("description"),
    icon: t.text("icon"),
    type: t.text("type").default("compose"),
    // Last successfully deployed source; edits are saved separately.
    spec: t.text("spec"),
    draftSpec: t.text("draft_spec"),
    settings: t.jsonb("settings"),
    // Migration makes this FK deferred so organization-wide cascades can finish.
    gitConnectionId: t
        .uuid("git_connection_id")
        .references(() => gitConnections.id, { onDelete: "no action" }),
    gitSource: t.jsonb("git_source").$type<ResourceGitSource>(),
    projectId: t
        .uuid("project_id")
        .notNull()
        .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: t
        .timestamp("created_at", { withTimezone: true })
        .notNull()
        .$defaultFn(() => new Date()),
    updatedAt: t
        .timestamp("updated_at", { withTimezone: true })
        .notNull()
        .$defaultFn(() => new Date())
        .$onUpdate(() => new Date()),
});

export const resourceEnvVars = t.pgTable(
    "resource_env_vars",
    {
        id: t.uuid("id").primaryKey(),
        resourceId: t
            .uuid("resource_id")
            .notNull()
            .references(() => resources.id, { onDelete: "cascade" }),
        service: t.text("service"), // null = shared/global, else compose service name
        key: t.text("key").notNull(),
        value: t.text("value").notNull(), // plaintext (Dokploy-style)
        secret: t.boolean("secret").notNull().default(false), // mask in UI when true
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        // nullsNotDistinct: NULL service (global) still conflicts on (resourceId, key)
        t
            .unique("resource_env_service_key_uidx")
            .on(table.resourceId, table.service, table.key)
            .nullsNotDistinct(),
        t.index("resource_env_resource_idx").on(table.resourceId),
    ],
);

// Private provisioning state. Never return this table through resource/project APIs.
export const clusterMonitoring = t.pgTable("cluster_monitoring", {
    clusterId: t
        .uuid("cluster_id")
        .primaryKey()
        .references(() => clusters.id, { onDelete: "cascade" }),
    projectId: t
        .uuid("project_id")
        .notNull()
        .unique()
        .references(() => projects.id, { onDelete: "cascade" }),
    resourceId: t
        .uuid("resource_id")
        .notNull()
        .unique()
        .references(() => resources.id, { onDelete: "cascade" }),
    machineId: t.text("machine_id").notNull(),
    encryptedPassword: t.text("encrypted_password").notNull(),
});

// Vercel-style deployment trail. One row per initialize/retry request so the
// cluster page can show history; the worker streams progress lines into
// deployment_logs while the job runs.
export type DeploymentStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export const deployments = t.pgTable(
    "deployments",
    {
        id: t.uuid("id").primaryKey(),
        clusterId: t
            .uuid("cluster_id")
            .notNull()
            .references(() => clusters.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        resourceId: t.uuid("resource_id").references(() => resources.id, { onDelete: "cascade" }),
        status: t.text("status").notNull().default("queued"),
        // Deterministic effect-mq job id (`${clusterId}:${requestId}`), used by
        // the worker to attach progress to the right deployment.
        jobId: t.text("job_id").notNull().unique(),
        configuration: t.jsonb("configuration").$type<ClusterInitializationConfiguration>(),
        error: t.text("error"),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
        finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    },
    (table) => [t.index("deployments_cluster_idx").on(table.clusterId, table.createdAt.desc())],
);

export const deploymentLogs = t.pgTable(
    "deployment_logs",
    {
        id: t.bigserial("id", { mode: "number" }).primaryKey(),
        deploymentId: t
            .uuid("deployment_id")
            .notNull()
            .references(() => deployments.id, { onDelete: "cascade" }),
        stream: t.text("stream").notNull().default("build"),
        text: t.text("text").notNull(),
        metadata: t
            .jsonb("metadata")
            .$type<{ level?: "info" | "debug" | "error"; event?: string }>()
            .notNull()
            .default({}),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("deployment_logs_deployment_idx").on(table.deploymentId, table.id)],
);

// Private source snapshot and naming prefix. Never join into public deployment reads.
export const resourceDeploymentInputs = t.pgTable("resource_deployment_inputs", {
    deploymentId: t
        .uuid("deployment_id")
        .primaryKey()
        .references(() => deployments.id, { onDelete: "cascade" }),
    spec: t.text("spec").notNull(),
    prefix: t.text("prefix").notNull(),
});

export * from "./auth";
