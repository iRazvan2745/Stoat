// oxlint-disable oxc/no-barrel-file sort-keys
import { relations } from "drizzle-orm/_relations";
import {
    bigserial,
    boolean,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import {
    mqDedupe,
    mqFlowChildren,
    mqFlowOutbox,
    mqJobAttempts,
    mqJobs,
    mqQueueControl,
    mqSchedules,
} from "effect-mq/drizzle-postgres";

import type { GitAuthMethod } from "#lib/domain/data-sources";
import type { GitServiceSyncState, GitSyncResult } from "#lib/domain/git-sync";
import type { ServiceSettings } from "#lib/domain/services/settings";

import { organization } from "./auth.schema";

export const effectMqJobs = mqJobs();
export const effectMqJobAttempts = mqJobAttempts(effectMqJobs);
export const effectMqSchedules = mqSchedules();
export const effectMqQueues = mqQueueControl();
export const effectMqDedupe = mqDedupe();
export const effectMqFlowChildren = mqFlowChildren();
export const effectMqFlowOutbox = mqFlowOutbox();

export const gitSource = pgTable(
    "git_source",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "restrict" }),
        name: text("name").notNull(),
        // Nullable only for the migration-created local source used by legacy
        // data sources that did not have a Git repository configured.
        url: text("url"),
        authMethod: text("auth_method").$type<GitAuthMethod>().notNull().default("none"),
        username: text("username"),
        password: text("password"),
        token: text("token"),
        sshPrivateKey: text("ssh_private_key"),
        sshPassphrase: text("ssh_passphrase"),
        sshKnownHosts: text("ssh_known_hosts"),
        syncEnabled: boolean("sync_enabled").notNull().default(false),
        lastSyncedCommit: text("last_synced_commit"),
        syncResult: jsonb("sync_result").$type<GitSyncResult>(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [index("git_source_organization_id_idx").on(table.organizationId)],
);

export const dataSource = pgTable(
    "data_source",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "restrict" }),
        gitSourceId: text("git_source_id")
            .notNull()
            .references(() => gitSource.id, { onDelete: "restrict" }),
        uncloudUrl: text("uncloud_url").notNull(),
        uncloudToken: text("uncloud_token"),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [index("data_source_organization_id_idx").on(table.organizationId)],
);

export const workspace = pgTable(
    "workspace",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        dataSourceId: text("data_source_id")
            .notNull()
            .references(() => dataSource.id, { onDelete: "restrict" }),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "restrict" }),
        name: text("name"),
        slug: text("slug").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        // Discovery looks up workspaces by data source (and name).
        index("workspace_data_source_id_idx").on(table.dataSourceId, table.name),
        index("workspace_organization_id_idx").on(table.organizationId),
        // uniqueSlug() already assumes global uniqueness; enforce it.
        uniqueIndex("workspace_slug_idx").on(table.slug),
    ],
);

export const services = pgTable(
    "services",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspace.id, { onDelete: "restrict" }),
        groupName: text("group_name"),
        gitSync: jsonb("git_sync").$type<GitServiceSyncState>(),
        type: text("type").default("compose"),
        name: text("name"),
        slug: text("slug"),
        icon: text("icon"),
        value: text("value"),
        settings: jsonb("settings").$type<ServiceSettings>().notNull().default({}),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("services_workspace_id_idx").on(table.workspaceId),
        // uniqueSlug() already assumes global uniqueness; NULLs are allowed.
        uniqueIndex("services_slug_idx").on(table.slug),
    ],
);

export const dataSourceRelations = relations(dataSource, ({ many, one }) => ({
    organization: one(organization, {
        fields: [dataSource.organizationId],
        references: [organization.id],
    }),
    gitSource: one(gitSource, {
        fields: [dataSource.gitSourceId],
        references: [gitSource.id],
    }),
    workspaces: many(workspace),
}));

export const gitSourceRelations = relations(gitSource, ({ many, one }) => ({
    dataSources: many(dataSource),
    organization: one(organization, {
        fields: [gitSource.organizationId],
        references: [organization.id],
    }),
}));

export const workspaceRelations = relations(workspace, ({ many, one }) => ({
    dataSource: one(dataSource, {
        fields: [workspace.dataSourceId],
        references: [dataSource.id],
    }),
    organization: one(organization, {
        fields: [workspace.organizationId],
        references: [organization.id],
    }),
    services: many(services),
}));

export const servicesRelations = relations(services, ({ one }) => ({
    workspace: one(workspace, {
        fields: [services.workspaceId],
        references: [workspace.id],
    }),
}));

export const deployments = pgTable(
    "deployments",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),

        serviceId: text("service_id")
            .notNull()
            .references(() => services.id, { onDelete: "cascade" }),

        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),

        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),

        queuedAt: timestamp("queued_at", { withTimezone: true }),
        startedAt: timestamp("started_at", { withTimezone: true }),
        finishedAt: timestamp("finished_at", { withTimezone: true }),
        outcome: text("outcome"),
        jobId: text("job_id"),
        gitCommit: text("git_commit"),
        settings: jsonb("settings").$type<ServiceSettings>().notNull().default({}),
    },
    (table) => [
        // Deployment list per service, ordered by createdAt/id (scanned
        // backwards for DESC). The serviceId prefix also serves the
        // "last successful deployment" and "unfinished deployments" queries.
        index("deployments_service_id_created_at_idx").on(
            table.serviceId,
            table.createdAt,
            table.id,
        ),
    ],
);

export const deploymentLogs = pgTable(
    "deployment_logs",
    {
        id: bigserial("id", { mode: "number" }).primaryKey(),

        deploymentId: text("deployment_id")
            .notNull()
            .references(() => deployments.id, { onDelete: "cascade" }),

        stream: text("stream").notNull(),

        message: text("message").notNull(),

        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [index("deployment_logs_deployment_id_id_idx").on(table.deploymentId, table.id)],
);

export const environmentVariables = pgTable(
    "environment_variables",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        serviceId: text("service_id")
            .notNull()
            .references(() => services.id, { onDelete: "restrict" }),
        name: text("name").notNull(),
        value: text("value").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        // Serves both the per-service filter and the ORDER BY name.
        index("environment_variables_service_id_name_idx").on(table.serviceId, table.name),
    ],
);

export * from "./auth.schema";
