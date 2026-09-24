ALTER TABLE "clusters" RENAME COLUMN "organization_id" TO "cluster_id";--> statement-breakpoint
ALTER TABLE "clusters" DROP CONSTRAINT "clusters_slug_format_ck";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_format_ck";--> statement-breakpoint
ALTER TABLE "resources" DROP CONSTRAINT "resources_slug_format_ck";--> statement-breakpoint
ALTER TABLE "clusters" DROP CONSTRAINT "clusters_organization_id_organization_id_fk";
--> statement-breakpoint
DROP INDEX "clusters_organization_id_idx";--> statement-breakpoint
DROP INDEX "clusters_organization_id_slug_uidx";--> statement-breakpoint
DROP INDEX "projects_cluster_id_idx";--> statement-breakpoint
DROP INDEX "projects_cluster_id_slug_uidx";--> statement-breakpoint
DROP INDEX "resources_project_id_idx";--> statement-breakpoint
DROP INDEX "resources_project_id_slug_uidx";--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_cluster_id_organization_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clusters" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "resources" DROP COLUMN "slug";