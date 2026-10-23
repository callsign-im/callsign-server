CREATE FUNCTION ledger_events_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_events_append_only
BEFORE UPDATE OR DELETE ON ledger_events
FOR EACH ROW EXECUTE FUNCTION ledger_events_reject_mutation();
