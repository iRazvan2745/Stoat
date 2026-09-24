CREATE TABLE "resource_deployment_inputs" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"spec" text NOT NULL,
	"prefix" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_deployment_inputs" ADD CONSTRAINT "resource_deployment_inputs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION notify_deployment_change() RETURNS trigger AS $$
DECLARE
    deployment_id uuid;
    cluster_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'deployments' THEN
        IF TG_OP = 'DELETE' THEN
            deployment_id := OLD.id;
            cluster_id := OLD.cluster_id;
        ELSE
            deployment_id := NEW.id;
            cluster_id := NEW.cluster_id;
        END IF;
        PERFORM pg_notify('deployment_list_changes', deployment_id::text || ':' || cluster_id::text);
    ELSE
        IF TG_OP = 'DELETE' THEN
            deployment_id := OLD.deployment_id;
        ELSE
            deployment_id := NEW.deployment_id;
        END IF;
        SELECT d.cluster_id INTO cluster_id FROM deployments d WHERE d.id = deployment_id;
    END IF;

    IF cluster_id IS NOT NULL THEN
        PERFORM pg_notify('deployment_changes', deployment_id::text || ':' || cluster_id::text);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER deployments_notify
AFTER INSERT OR UPDATE OR DELETE ON deployments
FOR EACH ROW EXECUTE FUNCTION notify_deployment_change();
--> statement-breakpoint
CREATE TRIGGER deployment_logs_notify
AFTER INSERT OR UPDATE OR DELETE ON deployment_logs
FOR EACH ROW EXECUTE FUNCTION notify_deployment_change();
