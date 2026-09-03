-- Addendum v1.1 §3: the MO pre-drafts the prescription and the doctor reviews a
-- diff, so a proposal is a row of the draft rather than an entry in a list
-- beside it. docs/gini-flow/24-ADDENDUM-V11-PLAN.md §4.
--
-- `proposed_by` NULL means "the doctor's own row". Only rows an MO created carry
-- an approval_status, and only 'pending' blocks finalize.
--
-- The addendum writes `proposed_by uuid`; it is INT here because doctors.id is,
-- and every other actor column in this schema follows that.
ALTER TABLE giniflow_rx_items
  ADD COLUMN IF NOT EXISTS proposed_by     INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS approval_status TEXT,
  ADD COLUMN IF NOT EXISTS decided_by      INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS decided_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note   TEXT;

DO $$
BEGIN
  ALTER TABLE giniflow_rx_items
    ADD CONSTRAINT giniflow_rx_items_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'adjusted', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- What finalize asks on every call: "is anything still pending?" A partial index
-- makes that free rather than a scan of the day's rows.
CREATE INDEX IF NOT EXISTS idx_giniflow_rx_items_pending
  ON giniflow_rx_items (visit_id) WHERE approval_status = 'pending';
