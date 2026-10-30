SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_lab_cases_outside_insert ON lab_cases;
CREATE TRIGGER trg_lab_cases_outside_insert AFTER INSERT ON lab_cases
  FOR EACH ROW EXECUTE FUNCTION giniflow_queue_outside_case();

DROP TRIGGER IF EXISTS trg_lab_cases_outside_update ON lab_cases;
CREATE TRIGGER trg_lab_cases_outside_update
  AFTER UPDATE OF case_date, patient_id, raw_list_json, raw_detail_json, case_status, test_names,
                  case_source, pdf_storage_path, results_synced
  ON lab_cases FOR EACH ROW
  WHEN (OLD.case_date IS DISTINCT FROM NEW.case_date
        OR OLD.patient_id IS DISTINCT FROM NEW.patient_id
        OR OLD.raw_list_json IS DISTINCT FROM NEW.raw_list_json
        OR OLD.raw_detail_json IS DISTINCT FROM NEW.raw_detail_json
        OR OLD.case_status IS DISTINCT FROM NEW.case_status
        OR OLD.test_names IS DISTINCT FROM NEW.test_names
        OR OLD.case_source IS DISTINCT FROM NEW.case_source
        OR OLD.pdf_storage_path IS DISTINCT FROM NEW.pdf_storage_path
        OR OLD.results_synced IS DISTINCT FROM NEW.results_synced)
  EXECUTE FUNCTION giniflow_queue_outside_case();
