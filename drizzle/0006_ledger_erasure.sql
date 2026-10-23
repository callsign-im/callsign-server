CREATE OR REPLACE FUNCTION ledger_events_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.agent_id::text = current_setting('callsign.erasing_agent', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ledger_events is append-only';
END;
$$;
