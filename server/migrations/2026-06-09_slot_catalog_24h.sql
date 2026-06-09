-- ============================================================
-- Make the slot catalog cover the full 24 hours (night shifts)
-- 2026-06-09
--
-- Adds evening + overnight + early-morning slots so doctors on night shifts
-- have bookable slots. Together with the existing daytime slots (09:30–17:00)
-- this gives continuous 24h coverage. Idempotent.
-- ============================================================

INSERT INTO slot_catalog (label, start_time, end_time, sort_order) VALUES
  ('5 PM to 6 PM',     '17:00', '18:00', 12),
  ('6 PM to 7 PM',     '18:00', '19:00', 13),
  ('7 PM to 8 PM',     '19:00', '20:00', 14),
  ('8 PM to 9 PM',     '20:00', '21:00', 15),
  ('9 PM to 10 PM',    '21:00', '22:00', 16),
  ('10 PM to 11 PM',   '22:00', '23:00', 17),
  ('11 PM to 12 AM',   '23:00', '00:00', 18),
  ('12 AM to 1 AM',    '00:00', '01:00', 19),
  ('1 AM to 2 AM',     '01:00', '02:00', 20),
  ('2 AM to 3 AM',     '02:00', '03:00', 21),
  ('3 AM to 4 AM',     '03:00', '04:00', 22),
  ('4 AM to 5 AM',     '04:00', '05:00', 23),
  ('5 AM to 6 AM',     '05:00', '06:00', 24),
  ('6 AM to 7 AM',     '06:00', '07:00', 25),
  ('7 AM to 8 AM',     '07:00', '08:00', 26),
  ('8 AM to 9 AM',     '08:00', '09:00', 27),
  ('9 AM to 9:30 AM',  '09:00', '09:30', 28)
ON CONFLICT (label) DO NOTHING;
