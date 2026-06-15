-- ============================================================
-- De-hardcode the chief step label.
-- 2026-06-15
--
-- The seed used a specific doctor name ("Dr. Bhansali") as the chief step's
-- display name, so every patient's journey showed that name. The step is now a
-- generic "Chief Consultation"; the actual doctor is assigned per-visit
-- (defaults exist, but the assignee is dynamic — pre-filled from the patient's
-- care team at check-in). No specific staff names in seed data.
-- Idempotent.
-- ============================================================

UPDATE flow_step_catalog SET name = 'Chief Consultation' WHERE id = 'chief_consult';
