SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_patient_bills_outside_insert ON giniflow_patient_bills;
CREATE TRIGGER trg_patient_bills_outside_insert AFTER INSERT ON giniflow_patient_bills
  FOR EACH ROW EXECUTE FUNCTION giniflow_queue_outside_bill();

DROP TRIGGER IF EXISTS trg_patient_bills_outside_update ON giniflow_patient_bills;
CREATE TRIGGER trg_patient_bills_outside_update AFTER UPDATE ON giniflow_patient_bills
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.items IS DISTINCT FROM NEW.items)
  EXECUTE FUNCTION giniflow_queue_outside_bill();
