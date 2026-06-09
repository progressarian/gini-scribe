-- ============================================================
-- Extend the bookable slot catalog to 5 PM
-- 2026-06-09
--
-- The catalog previously stopped at 4 PM, so doctors with working hours past
-- 4 PM had no slots to show/book in 4–5 PM. Add the two missing half-hour slots.
-- Idempotent.
-- ============================================================

INSERT INTO slot_catalog (label, start_time, end_time, sort_order) VALUES
  ('4 PM to 4:30 PM', '16:00', '16:30', 10),
  ('4:30 PM to 5 PM', '16:30', '17:00', 11)
ON CONFLICT (label) DO NOTHING;
