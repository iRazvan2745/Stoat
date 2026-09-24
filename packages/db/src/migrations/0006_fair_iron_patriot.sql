ALTER TABLE "clusters" RENAME COLUMN "cluster_id" TO "organization_id";--> statement-breakpoint
ALTER TABLE "clusters" DROP CONSTRAINT "clusters_cluster_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;