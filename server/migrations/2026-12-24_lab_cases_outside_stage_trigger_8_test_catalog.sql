SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_test_catalog_outside ON giniflow_test_catalog;
CREATE TRIGGER trg_test_catalog_outside AFTER UPDATE OF test_name ON giniflow_test_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION giniflow_queue_outside_every_case();
