CREATE TABLE IF NOT EXISTS giniflow_plan_suggestions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id       UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  field          TEXT NOT NULL CHECK (field IN ('advice', 'treatment', 'lifestyle', 'goals', 'next_visit')),
  value          JSONB NOT NULL,
  proposed_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed', 'accepted', 'edited', 'dismissed', 'withdrawn')),
  decided_by     INT REFERENCES doctors(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  decided_value  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS giniflow_plan_suggestions_one_open
  ON giniflow_plan_suggestions (visit_id, field) WHERE status = 'proposed';

CREATE INDEX IF NOT EXISTS giniflow_plan_suggestions_visit
  ON giniflow_plan_suggestions (visit_id, created_at);

COMMENT ON TABLE giniflow_plan_suggestions IS
  'Advice and care-plan suggestions from the Chief Endocrinologist. Never printed; the consultant accepts (copied into giniflow_care_plans), edits or dismisses each one.';
