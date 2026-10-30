SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_visit_steps_outside ON giniflow_visit_steps;
CREATE TRIGGER trg_visit_steps_outside AFTER INSERT OR UPDATE OF status ON giniflow_visit_steps
  FOR EACH ROW WHEN (NEW.step_catalog_id = 'lab_billing')
  EXECUTE FUNCTION giniflow_queue_outside_visit();
