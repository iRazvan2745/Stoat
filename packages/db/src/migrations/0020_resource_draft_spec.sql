ALTER TABLE "resources" ADD COLUMN "draft_spec" text;
--> statement-breakpoint
UPDATE "resources" SET "draft_spec" = "spec";
--> statement-breakpoint
-- Keep legacy specs without deployment history: they may already be deployed.
-- Tracked resources use only confirmed successful snapshots, never saved drafts.
UPDATE "resources" AS r
SET "spec" = (
    SELECT i."spec"
    FROM "deployments" AS d
    JOIN "resource_deployment_inputs" AS i ON i."deployment_id" = d."id"
    WHERE d."resource_id" = r."id" AND d."name" = 'DeployResource' AND d."status" = 'ready'
    ORDER BY d."finished_at" DESC, d."created_at" DESC
    LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM "deployments" AS d WHERE d."resource_id" = r."id");
--> statement-breakpoint
UPDATE "resources" AS r
SET "spec" = NULL
FROM "cluster_monitoring" AS m
JOIN "clusters" AS c ON c."id" = m."cluster_id"
WHERE r."id" = m."resource_id" AND c."initialised_at" IS NULL;
