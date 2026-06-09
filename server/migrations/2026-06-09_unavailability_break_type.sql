-- ============================================================
-- Add 'break' as a doctor_unavailability type
-- 2026-06-09
--
-- A break is a slot-scoped unavailability (lunch, admin time). It shares the
-- doctor_unavailability table with leave/holiday/emergency; only the type and
-- the requirement of slot_labels differ. Idempotent.
-- ============================================================

ALTER TABLE doctor_unavailability DROP CONSTRAINT IF EXISTS doctor_unavailability_type_check;
ALTER TABLE doctor_unavailability
  ADD CONSTRAINT doctor_unavailability_type_check
  CHECK (type IN ('leave', 'emergency', 'holiday', 'break'));
