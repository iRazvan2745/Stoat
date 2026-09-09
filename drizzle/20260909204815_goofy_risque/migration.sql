CREATE TABLE "workspace_environment_variables" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_environment_variables_workspace_id_name_idx" ON "workspace_environment_variables" ("workspace_id","name");--> statement-breakpoint
ALTER TABLE "workspace_environment_variables" ADD CONSTRAINT "workspace_environment_variables_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;