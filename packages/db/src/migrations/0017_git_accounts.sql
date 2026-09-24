ALTER TABLE "git_connections" ADD COLUMN "provider" text;
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "server_url" text;
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "auth_type" text DEFAULT 'token' NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "account" jsonb;
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "repositories" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- Existing connections retain their credentials and known repository as a generic server account.
UPDATE "git_connections" SET
    "provider" = 'generic',
    "server_url" = regexp_replace("url", '^([a-z]+://)([^/@]+@)?([^/]+).*$', '\1\3'),
    "repositories" = jsonb_build_array(jsonb_build_object('url', "url", 'name', "name", 'defaultBranch', "branch"));
--> statement-breakpoint
UPDATE "resources" r SET "git_source" = r."git_source" || jsonb_build_object('repositoryUrl', c."url")
FROM "git_connections" c WHERE r."git_connection_id" = c."id" AND r."git_source" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_connections" ALTER COLUMN "provider" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_connections" ALTER COLUMN "server_url" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_connections" DROP COLUMN "url";
--> statement-breakpoint
ALTER TABLE "git_connections" DROP COLUMN "branch";
