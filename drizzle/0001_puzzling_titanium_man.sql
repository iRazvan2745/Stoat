ALTER TABLE "workspace" ADD COLUMN "data_source_id" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_data_source_id_data_source_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_source"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_data_source_id_required" CHECK ("data_source_id" IS NOT NULL) NOT VALID;
