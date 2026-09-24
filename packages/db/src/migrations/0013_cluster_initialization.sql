CREATE TABLE "cluster_monitoring" (
	"cluster_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"machine_id" text NOT NULL,
	"encrypted_password" text NOT NULL,
	CONSTRAINT "cluster_monitoring_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "cluster_monitoring_resource_id_unique" UNIQUE("resource_id")
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "initialization_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "initialization_status" text DEFAULT 'uninitialized' NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "initialization_error" text;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "initialization_configuration" jsonb;--> statement-breakpoint
ALTER TABLE "cluster_monitoring" ADD CONSTRAINT "cluster_monitoring_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_monitoring" ADD CONSTRAINT "cluster_monitoring_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_monitoring" ADD CONSTRAINT "cluster_monitoring_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;