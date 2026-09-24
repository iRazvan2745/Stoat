CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sidecar_url" text,
	"sidecar_token" text,
	"greptime_url" text,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clusters_slug_format_ck" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"cluster_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_format_ck" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"icon" text,
	"type" text DEFAULT 'compose' NOT NULL,
	"spec" text,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_slug_format_ck" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clusters_organization_id_idx" ON "clusters" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clusters_organization_id_slug_uidx" ON "clusters" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "projects_cluster_id_idx" ON "projects" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_cluster_id_slug_uidx" ON "projects" USING btree ("cluster_id","slug");--> statement-breakpoint
CREATE INDEX "resources_project_id_idx" ON "resources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_project_id_slug_uidx" ON "resources" USING btree ("project_id","slug");