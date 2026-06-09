-- ============================================================
-- Make doctor_availability.capacity OPTIONAL (unlimited by default)
-- 2026-06-08
--
-- A doctor just marks that they are available on a date (+ optional slots).
-- Putting a patient cap is optional: NULL = unlimited, or set 1/2/… to limit.
-- Idempotent. doctor_availability is new + empty, so this only relaxes the
-- column constraints.
-- ============================================================

ALTER TABLE doctor_availability ALTER COLUMN capacity DROP NOT NULL;
ALTER TABLE doctor_availability ALTER COLUMN capacity DROP DEFAULT;
-- existing CHECK (capacity >= 0) still holds; CHECK passes on NULL.
