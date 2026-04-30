-- Aggressive dedup pass for goals: the prior partial-index migration only
-- caught (consultation_id, marker) collisions, but P_5900-style duplicates
-- span different consultation_ids and/or have consultation_id = NULL.
-- This migration collapses by (patient_id, marker, target_value, timeline)
-- — i.e. true semantic duplicates — keeping the oldest row per group.

DELETE FROM goals g
USING goals g2
WHERE g.patient_id = g2.patient_id
  AND g.marker = g2.marker
  AND COALESCE(g.target_value, '') = COALESCE(g2.target_value, '')
  AND COALESCE(g.timeline,     '') = COALESCE(g2.timeline,     '')
  AND g.id > g2.id;
