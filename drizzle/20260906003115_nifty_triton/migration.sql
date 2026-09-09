ALTER TABLE "services" ADD COLUMN "sort_order" double precision;
--> statement-breakpoint
WITH "renumbered" AS (
    SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "rn"
    FROM "services"
)
UPDATE "services"
SET "sort_order" = "renumbered"."rn" * 1024
FROM "renumbered"
WHERE "services"."id" = "renumbered"."id";
