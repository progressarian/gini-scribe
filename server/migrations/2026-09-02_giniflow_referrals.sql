-- ============================================================
-- Referrals — the letter out, and the specialist who answers it.
-- 2026-09-02
--
-- docs/gini-flow/19-REFERRALS-STATION-PLAN.md §8
--
-- A referral is a PARALLEL artefact, like a lab order — not a step in the
-- chain. The patient does not walk to a "referrals desk"; they walk out of the
-- building with a letter, and the visit continues to pharmacy and exit exactly
-- as it would have. So the four statuses below live on this row and are read
-- only by this station: nothing is added to CHAIN, STATUS_LABEL,
-- STATUS_TO_SLA_KEY, BOARD_COLUMNS or ACTOR_ROLES, and `current_status` never
-- moves because of a referral. The precedent is
-- `giniflow_lab_orders.sample_status`.
--
-- Why a NEW table rather than the `referrals` one `server/routes/visit.js:119`
-- creates at boot: the giniflow_* separation of 00-OVERVIEW.md §2.3. The debt is
-- real and is stated in the plan rather than discovered later — a referral made
-- in Scribe's visit page will not appear here, and vice versa. That table is not
-- a flow_* table, so retiring or merging it is its own piece of work.
--
-- `urgency` and `status` are TEXT with a trailing comment, not PG enums — the
-- house rule, so the vocabulary can grow without a migration. Both vocabularies
-- live in shared/giniflowReferrals.js.
-- ============================================================

CREATE TABLE IF NOT EXISTS giniflow_referrals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id          INT  NOT NULL REFERENCES patients(id),
  to_doctor           TEXT,
  to_doctor_phone     TEXT,
  specialty           TEXT NOT NULL,
  hospital            TEXT,
  urgency             TEXT NOT NULL DEFAULT 'routine',  -- routine | soon | urgent | emergency
  reason              TEXT,
  investigations      TEXT,
  letter_file_url     TEXT,
  letter_generated_at TIMESTAMPTZ,
  letter_sent_at      TIMESTAMPTZ,
  sent_to             TEXT,                              -- patient | doctor | both
  appointment_date    DATE,
  appointment_note    TEXT,
  status              TEXT NOT NULL DEFAULT 'created',   -- created | letter_generated | appointment_booked | completed
  created_by          INT REFERENCES doctors(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giniflow_referrals_visit   ON giniflow_referrals (visit_id);
CREATE INDEX IF NOT EXISTS idx_giniflow_referrals_created ON giniflow_referrals (created_at DESC);

-- The consultant's chips are per visit, not per patient — they are THIS
-- consultation's decisions. One row per (visit, specialty) is therefore the
-- whole meaning of a selected chip, and the toggle needs the constraint to be
-- idempotent rather than to produce a second identical letter on a double tap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_giniflow_referrals_visit_specialty
  ON giniflow_referrals (visit_id, specialty);

COMMENT ON TABLE giniflow_referrals IS
  'Gini Flow external referrals. Parallel to the status chain — never moves giniflow_visits.current_status. docs/gini-flow/19-REFERRALS-STATION-PLAN.md';
COMMENT ON COLUMN giniflow_referrals.status IS
  'The LETTER''s journey, not the patient''s: appointment_booked means the external clinic gave a slot. Gini books nothing.';
COMMENT ON COLUMN giniflow_referrals.letter_sent_at IS
  'Stamped ONLY when a message actually left the building — MSG91 logs instead of sending until the template is approved, and this column is the idempotency guard.';
