-- ============================================================
-- Consultant station, Part 2 — prescription draft, timing, and stock.
-- 2026-09-02
--
-- docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md
--
-- The repo has ONE prescription history: `medications`. The brief proposed a
-- second (`prescription_items` + `external_medicines`), but the refill queue,
-- the dose-review queue, the medicine card, MHG and the Genie sync all read the
-- existing table, and a second history is the failure this module is structured
-- to avoid. So the consultant writes `medications`, and this migration adds only
-- what the prototype needs and that table lacks.
--
-- PLAN CORRECTION — three columns, not four. The plan listed `change_note`
-- ("20mg→40mg, LDL 127"), but `medications.previous_dose` already stores the
-- dose a medicine was changed FROM, and `clinical_note` stores the why. The note
-- is those two rendered together, so storing it again would create a third place
-- for the same fact to be wrong. `is_new` also already exists; `change_type`
-- still earns its place because it distinguishes changed / paused / stopped,
-- which a boolean cannot.
-- ============================================================

ALTER TABLE medications
  -- The machine-readable partner of the existing free-text `timing`. The
  -- medicine card groups on this; the patient still reads `when_to_take`.
  ADD COLUMN IF NOT EXISTS timing_category TEXT,
  -- The actual clock time a dose is taken (07:30), which is what turns a list of
  -- medicines into a daily schedule.
  ADD COLUMN IF NOT EXISTS time_of_day     TIME,
  -- continued | changed | new | stopped | paused — drives the "🆕 Added this
  -- visit" / "↑ Changed" chips and the pharmacy's Hindi counselling note.
  ADD COLUMN IF NOT EXISTS change_type     TEXT;

-- ── The draft ───────────────────────────────────────────────────────────────
-- Nothing a consultant types reaches the prescription history until Finalize.
-- The draft is its own table for that reason: a consultation interrupted by a
-- phone call must lose nothing, and a half-finished prescription must never be
-- dispensable or visible in the patient's app.
--
-- `source_medication_id` links a draft row back to the active medication it
-- continues or changes, so Finalize knows which row to update rather than
-- creating a duplicate under a slightly different brand spelling.
CREATE TABLE IF NOT EXISTS giniflow_rx_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id             UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  source_medication_id INT  REFERENCES medications(id) ON DELETE SET NULL,
  medicine_name        TEXT NOT NULL,
  pharmacy_match       TEXT,
  composition          TEXT,
  dose                 TEXT,
  previous_dose        TEXT,
  frequency            TEXT,
  timing               TEXT,
  timing_category      TEXT,
  time_of_day          TIME,
  route                TEXT DEFAULT 'Oral',
  form                 TEXT,
  duration             TEXT,
  reason               TEXT,
  patient_instruction  TEXT,
  change_type          TEXT NOT NULL DEFAULT 'new',
  stop_reason          TEXT,
  resume_on            DATE,
  drug_class           TEXT,
  sort_order           INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giniflow_rx_items_visit
  ON giniflow_rx_items (visit_id, sort_order);

-- ── Stock ───────────────────────────────────────────────────────────────────
-- The prototype shows stock on every row, a low-stock warning, an out-of-stock
-- block and an alternatives flow. There is no inventory anywhere in this repo,
-- and the brief's own open question #3 asks Nikhil where stock comes from.
--
-- Created here with the brief's exact shape and SEEDED EMPTY on purpose. A row's
-- absence means "unknown", which the screen renders as "Stock —". It must never
-- render as "in stock": a false in-stock sends a patient to a counter that
-- cannot serve them, and makes the alternatives flow silently unreachable.
CREATE TABLE IF NOT EXISTS pharmacy_inventory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_name   TEXT NOT NULL UNIQUE,
  generic_name    TEXT,
  drug_class      TEXT,
  stock_qty       INT,
  reorder_level   INT,
  price_per_unit  NUMERIC(10, 2),
  -- Same-class substitutes for the out-of-stock flow. Names rather than ids so a
  -- substitute can be listed before it has an inventory row of its own.
  alternatives    TEXT[] NOT NULL DEFAULT '{}',
  source          TEXT NOT NULL DEFAULT 'manual',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_inventory_class ON pharmacy_inventory (drug_class);
