SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_lab_orders_outside ON giniflow_lab_orders;
CREATE TRIGGER trg_lab_orders_outside
  AFTER INSERT OR DELETE OR UPDATE OF visit_id, kind, urgency ON giniflow_lab_orders
  FOR EACH ROW EXECUTE FUNCTION giniflow_queue_outside_visit();
