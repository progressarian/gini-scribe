-- ============================================================
-- Clinic-day slots become 30 minutes, and the lunch break is lifted
-- 2026-08-21
--
-- Two changes, both booking-facing:
--
-- 1. The clinic day (09:00–17:00) was a mix of 1-hour and 30-minute slots.
--    Every hour-long slot in that window is split in two. Evening and
--    overnight slots (17:00–09:00, for night-shift doctors) keep their
--    1-hour shape — nobody books those through the GHM sheet.
--
--    The four replaced labels are DEACTIVATED, not deleted: appointments
--    store time_slot as free text, so old rows still carry '1 PM to 2 PM'
--    and must keep resolving. Every catalog read filters on is_active, so
--    they simply stop being offered for new bookings.
--
-- 2. The 1 PM–2 PM lunch break is removed. It came from
--    doctor_profile.lunch_start/lunch_end, which made the resolver return
--    reason='break' and grey the slot out in every booking dropdown.
--    Clearing both ends means "no recurring break" (see services/
--    availability.js:inLunch — it needs both bounds to block anything).
--    The break is still settable per doctor from Doctor Management.
--
-- Idempotent / safe to re-run.
-- ============================================================

-- ── 1. Retire the hour-long clinic-day slots ─────────────────
UPDATE slot_catalog
   SET is_active = FALSE
 WHERE label IN ('10 AM to 11 AM', '11 AM to 12 PM', '12 PM to 1 PM', '1 PM to 2 PM');

-- ── 2. Add the 30-minute replacements ────────────────────────
INSERT INTO slot_catalog (label, start_time, end_time, sort_order) VALUES
  ('10 AM to 10:30 AM',  '10:00', '10:30', 2),
  ('10:30 AM to 11 AM',  '10:30', '11:00', 3),
  ('11 AM to 11:30 AM',  '11:00', '11:30', 4),
  ('11:30 AM to 12 PM',  '11:30', '12:00', 5),
  ('12 PM to 12:30 PM',  '12:00', '12:30', 6),
  ('12:30 PM to 1 PM',   '12:30', '13:00', 7),
  ('1 PM to 1:30 PM',    '13:00', '13:30', 8),
  ('1:30 PM to 2 PM',    '13:30', '14:00', 9)
ON CONFLICT (label) DO UPDATE
  SET start_time = EXCLUDED.start_time,
      end_time   = EXCLUDED.end_time,
      sort_order = EXCLUDED.sort_order,
      is_active  = TRUE;

-- ── 3. Renumber so the dropdown reads in clock order ─────────
-- The day still starts at 9:30 AM and '9 AM to 9:30 AM' still sorts last,
-- exactly as before — only the numbers between them shift to make room.
UPDATE slot_catalog SET sort_order = v.ord
  FROM (VALUES
    ('9:30 AM to 10 AM', 1),
    ('2 PM to 2:30 PM', 10), ('2:30 PM to 3 PM', 11),
    ('3 PM to 3:30 PM', 12), ('3:30 PM to 4 PM', 13),
    ('4 PM to 4:30 PM', 14), ('4:30 PM to 5 PM', 15),
    ('5 PM to 6 PM', 16), ('6 PM to 7 PM', 17), ('7 PM to 8 PM', 18),
    ('8 PM to 9 PM', 19), ('9 PM to 10 PM', 20), ('10 PM to 11 PM', 21),
    ('11 PM to 12 AM', 22), ('12 AM to 1 AM', 23), ('1 AM to 2 AM', 24),
    ('2 AM to 3 AM', 25), ('3 AM to 4 AM', 26), ('4 AM to 5 AM', 27),
    ('5 AM to 6 AM', 28), ('6 AM to 7 AM', 29), ('7 AM to 8 AM', 30),
    ('8 AM to 9 AM', 31), ('9 AM to 9:30 AM', 32)
  ) AS v(label, ord)
 WHERE slot_catalog.label = v.label;

-- ── 4. Lift the recurring lunch break ────────────────────────
UPDATE doctor_profile
   SET lunch_start = NULL,
       lunch_end   = NULL,
       updated_at  = NOW()
 WHERE lunch_start IS NOT NULL
    OR lunch_end IS NOT NULL;
