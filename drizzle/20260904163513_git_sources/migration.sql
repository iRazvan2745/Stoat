CREATE TABLE "git_source" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"auth_method" text DEFAULT 'none' NOT NULL,
	"username" text,
	"password" text,
	"token" text,
	"ssh_private_key" text,
	"ssh_passphrase" text,
	"ssh_known_hosts" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_source" ADD COLUMN "git_source_id" text;--> statement-breakpoint
-- Existing installations kept the repository URL on the data source. Create
-- one public Git Source per legacy row before making the assignment required.
INSERT INTO "git_source" (
    "id",
    "organization_id",
    "name",
    "url",
    "auth_method",
    "username",
    "password",
    "token",
    "created_at",
    "updated_at"
)
SELECT
    md5('legacy-git-source:' || "id"),
    "organization_id",
    coalesce(
        nullif(
            regexp_replace(
                regexp_replace(trim("git_url"), '[?#].*$', ''),
                '^.*[/\\:]', ''
            ),
            ''
        ),
        'Local Git Source'
    ),
    nullif(
        regexp_replace(
            trim("git_url"),
            '^(https?://)[^/@]+@',
            '\1'
        ),
        ''
    ),
    CASE
        WHEN trim("git_url") ~ '^https?://[^/@:]+:[^/@]*@' THEN 'basic'
        WHEN trim("git_url") ~ '^https?://[^/@:]+@' THEN 'token'
        ELSE 'none'
    END,
    CASE
        WHEN trim("git_url") ~ '^https?://[^/@:]+:[^/@]*@'
        THEN substring(trim("git_url") FROM '^https?://([^/@:]+):')
        ELSE NULL
    END,
    CASE
        WHEN trim("git_url") ~ '^https?://[^/@:]+:[^/@]*@'
        THEN substring(trim("git_url") FROM '^https?://[^/@:]+:([^/@]*)@')
        ELSE NULL
    END,
    CASE
        WHEN trim("git_url") ~ '^https?://[^/@:]+@'
        THEN substring(trim("git_url") FROM '^https?://([^/@:]+)@')
        ELSE NULL
    END,
    "created_at",
    "updated_at"
FROM "data_source";--> statement-breakpoint
UPDATE "data_source"
SET "git_source_id" = md5('legacy-git-source:' || "id");--> statement-breakpoint
ALTER TABLE "data_source" ALTER COLUMN "git_source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "data_source" DROP COLUMN "git_url";--> statement-breakpoint
CREATE INDEX "git_source_organization_id_idx" ON "git_source" ("organization_id");--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_git_source_id_git_source_id_fkey" FOREIGN KEY ("git_source_id") REFERENCES "git_source"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "git_source" ADD CONSTRAINT "git_source_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT;
