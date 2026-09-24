-- Keep account creation and its initial owner membership atomic, including users
-- created through the admin API. A failed insert rolls back all three records.
CREATE FUNCTION provision_user_organization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    org_id text := gen_random_uuid()::text;
BEGIN
    INSERT INTO organization (id, name, slug, created_at)
    VALUES (org_id, COALESCE(NULLIF(btrim(NEW.name), ''), 'Personal') || '''s organization', 'org-' || org_id, now());
    INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (gen_random_uuid()::text, org_id, NEW.id, 'owner', now());
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_default_organization
AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION provision_user_organization();
--> statement-breakpoint
-- Existing accounts without a membership receive the same initial workspace.
DO $$
DECLARE
    existing_user record;
    org_id text;
BEGIN
    FOR existing_user IN SELECT u.id, u.name FROM "user" u
        WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m.user_id = u.id)
    LOOP
        org_id := gen_random_uuid()::text;
        INSERT INTO organization (id, name, slug, created_at)
        VALUES (org_id, COALESCE(NULLIF(btrim(existing_user.name), ''), 'Personal') || '''s organization', 'org-' || org_id, now());
        INSERT INTO member (id, organization_id, user_id, role, created_at)
        VALUES (gen_random_uuid()::text, org_id, existing_user.id, 'owner', now());
    END LOOP;
END;
$$;
--> statement-breakpoint
UPDATE session s SET active_organization_id = (
    SELECT m.organization_id FROM member m WHERE m.user_id = s.user_id
    ORDER BY m.created_at, m.id LIMIT 1
) WHERE s.active_organization_id IS NULL;
