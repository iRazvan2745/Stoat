ALTER TABLE "services" RENAME TO "resources";--> statement-breakpoint
ALTER TABLE "deployments" RENAME COLUMN "service_id" TO "resource_id";--> statement-breakpoint
ALTER TABLE "environment_variables" RENAME COLUMN "service_id" TO "resource_id";--> statement-breakpoint
ALTER INDEX "deployments_service_id_created_at_idx" RENAME TO "deployments_resource_id_created_at_idx";--> statement-breakpoint
ALTER INDEX "environment_variables_service_id_name_idx" RENAME TO "environment_variables_resource_id_name_idx";--> statement-breakpoint
ALTER INDEX "services_workspace_id_idx" RENAME TO "resources_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "services_slug_idx" RENAME TO "resources_slug_idx";