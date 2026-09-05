ALTER TABLE "deployments" ADD COLUMN "git_commit" text;--> statement-breakpoint
ALTER TABLE "git_source" ADD COLUMN "sync_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "git_source" ADD COLUMN "last_synced_commit" text;--> statement-breakpoint
ALTER TABLE "git_source" ADD COLUMN "sync_result" jsonb;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "git_sync" jsonb;