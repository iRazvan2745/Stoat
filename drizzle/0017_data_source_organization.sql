ALTER TABLE "data_source" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "data_source" AS ds
SET "organization_id" = w."organization_id"
FROM (
	SELECT DISTINCT ON ("data_source_id") "data_source_id", "organization_id"
	FROM "workspace"
	ORDER BY "data_source_id", "created_at" ASC
) AS w
WHERE ds."id" = w."data_source_id"
	AND ds."organization_id" IS NULL;--> statement-breakpoint
UPDATE "data_source"
SET "organization_id" = (SELECT "id" FROM "organization" ORDER BY "created_at" ASC LIMIT 1)
WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "data_source" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_organization_id_idx" ON "data_source" USING btree ("organization_id");
