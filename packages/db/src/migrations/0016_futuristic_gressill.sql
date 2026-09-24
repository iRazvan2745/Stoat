CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"branch" text NOT NULL,
	"encrypted_credentials" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "git_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "git_source" jsonb;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_connections_organization_idx" ON "git_connections" USING btree ("organization_id");--> statement-breakpoint
-- Organization deletion cascades through both connections and cluster/project/resources.
-- Check this cross-branch reference after those cascades finish.
ALTER TABLE "resources" ADD CONSTRAINT "resources_git_connection_id_git_connections_id_fk" FOREIGN KEY ("git_connection_id") REFERENCES "public"."git_connections"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
