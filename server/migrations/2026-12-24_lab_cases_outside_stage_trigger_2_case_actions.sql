SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_lab_case_actions_outside ON giniflow_lab_case_actions;
CREATE TRIGGER trg_lab_case_actions_outside AFTER INSERT OR UPDATE OR DELETE ON giniflow_lab_case_actions
  FOR EACH ROW EXECUTE FUNCTION giniflow_queue_outside_case();
