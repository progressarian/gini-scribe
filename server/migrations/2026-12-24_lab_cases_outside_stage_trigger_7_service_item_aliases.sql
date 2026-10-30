SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_service_item_aliases_outside ON service_item_aliases;
CREATE TRIGGER trg_service_item_aliases_outside
  AFTER INSERT OR UPDATE OR DELETE ON service_item_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION giniflow_queue_outside_every_case();
