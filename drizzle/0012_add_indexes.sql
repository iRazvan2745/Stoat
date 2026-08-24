ALTER TABLE "deployments" DROP CONSTRAINT "deployments_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "data_source" ADD COLUMN "uncloud_url" text NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployments_service_id_created_at_idx" ON "deployments" USING btree ("service_id","created_at","id");--> statement-breakpoint
CREATE INDEX "environment_variables_service_id_name_idx" ON "environment_variables" USING btree ("service_id","name");--> statement-breakpoint
CREATE INDEX "services_workspace_id_idx" ON "services" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_slug_idx" ON "services" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workspace_data_source_id_idx" ON "workspace" USING btree ("data_source_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_slug_idx" ON "workspace" USING btree ("slug");