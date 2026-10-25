-- Append-only audit log and immutable media manifests (PLAN §5, §7.1 PrepareMedia).
CREATE OR REPLACE FUNCTION mb_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION mb_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER media_manifests_immutable BEFORE UPDATE ON media_manifests
  FOR EACH ROW EXECUTE FUNCTION mb_forbid_mutation();
