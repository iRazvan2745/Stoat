CREATE TABLE "resource_env_vars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"service" text,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "resource_env_service_key_uidx" UNIQUE NULLS NOT DISTINCT("resource_id","service","key")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "is_internal" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "resource_env_vars" ADD CONSTRAINT "resource_env_vars_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_env_resource_idx" ON "resource_env_vars" USING btree ("resource_id");