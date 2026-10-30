SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_service_items_outside ON service_items;
CREATE TRIGGER trg_service_items_outside
  AFTER INSERT OR DELETE OR UPDATE OF is_outsourced, is_active, test_catalog_id ON service_items
  FOR EACH STATEMENT EXECUTE FUNCTION giniflow_queue_outside_every_case();
