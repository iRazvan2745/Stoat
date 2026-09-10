CREATE TABLE "resource_files" (
	"id" text PRIMARY KEY,
	"resource_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resource_files_resource_id_path_idx" ON "resource_files" ("resource_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_files_resource_id_path_uidx" ON "resource_files" ("resource_id","path");--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_resource_id_resources_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT;