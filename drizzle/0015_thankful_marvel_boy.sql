ALTER TABLE "workspace" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "workspace"
SET "organization_id" = (SELECT "id" FROM "organization" ORDER BY "created_at" ASC LIMIT 1)
WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_organization_id_idx" ON "workspace" USING btree ("organization_id");