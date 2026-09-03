-- The interaction check (24-ADDENDUM-V11-PLAN.md §5.2).
--
-- Rules live in a table, not in code, because they are clinical content: the
-- hospital's doctors have to be able to read the list, argue with a row, and
-- change one without a deploy. Every seeded row carries the reason it exists in
-- `note` — that text is what the consultant reads on the screen, so it says
-- what to do, not just that something is wrong.
--
-- Rules are on CLASS PAIRS. `class_a = class_b` is a duplication rule. Classes
-- are the normalised tokens from shared/giniflowInteractions.js, and the pair is
-- stored sorted so a lookup never has to try both orders.

CREATE TABLE IF NOT EXISTS giniflow_interaction_rules (
  id          SERIAL PRIMARY KEY,
  class_a     TEXT NOT NULL,
  class_b     TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('severe', 'moderate')),
  note        TEXT NOT NULL,
  source      TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (class_a <= class_b),
  UNIQUE (class_a, class_b)
);

-- A severe finding stops finalize until somebody says why they are prescribing
-- it anyway. It is NOT a hard block: dual antiplatelet after a stent, an MRA
-- with an ACE inhibitor in heart failure — the combinations the check is best at
-- spotting are often exactly the ones a cardiologist means. A check that cannot
-- be overridden gets worked around, and then it protects nobody.
--
-- The override is per visit and per rule, and it is recorded with a reason and a
-- name, because the point of the stop is the sentence it produces on the record.
CREATE TABLE IF NOT EXISTS giniflow_interaction_acks (
  id         BIGSERIAL PRIMARY KEY,
  visit_id   UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  rule_key   TEXT NOT NULL,
  severity   TEXT NOT NULL,
  medicines  TEXT[] NOT NULL DEFAULT '{}',
  reason     TEXT NOT NULL,
  acked_by   INTEGER REFERENCES doctors(id),
  acked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (visit_id, rule_key)
);

CREATE INDEX IF NOT EXISTS giniflow_interaction_acks_visit_idx
  ON giniflow_interaction_acks (visit_id);

-- ── The seed ────────────────────────────────────────────────────────────────
-- Deliberately small. Every row is a combination that turns up in a
-- cardio-metabolic OPD, and each note names the harm and the action. Rules for
-- combinations this clinic does not prescribe would only add noise to a screen
-- whose whole value is that its warnings are worth reading.

INSERT INTO giniflow_interaction_rules (class_a, class_b, severity, note, source) VALUES
  ('ACEI', 'ARB', 'severe',
   'Dual RAAS blockade — hyperkalaemia and acute kidney injury, with no outcome benefit (ONTARGET). Use one, not both.',
   'seed'),
  ('ACEI', 'ARNI', 'severe',
   'ARNi already contains valsartan, and an ACE inhibitor within 36 hours risks angioedema. Stop the ACE inhibitor and leave a 36-hour gap.',
   'seed'),
  ('ARB', 'ARNI', 'severe',
   'ARNi already contains an ARB. Prescribing both doubles the dose.',
   'seed'),
  ('ACEI', 'MRA', 'severe',
   'Hyperkalaemia. Often deliberate in heart failure — if so, say so and set the potassium check.',
   'seed'),
  ('ARB', 'MRA', 'severe',
   'Hyperkalaemia. Often deliberate in heart failure — if so, say so and set the potassium check.',
   'seed'),
  ('ANTICOAGULANT', 'ANTIPLATELET', 'severe',
   'Bleeding risk. Deliberate after stenting, and then only for a defined period — record the period.',
   'seed'),
  ('ANTICOAGULANT', 'NSAID', 'severe',
   'Gastrointestinal bleeding. Use paracetamol, or add gastroprotection and a defined stop date.',
   'seed'),
  ('NITRATE', 'PDE5I', 'severe',
   'Profound hypotension — an absolute contraindication. Not to be prescribed together at any interval.',
   'seed'),
  ('INSULIN', 'SULFONYLUREA', 'moderate',
   'Hypoglycaemia, especially overnight. Common and often intended — reduce the sulfonylurea as insulin goes up.',
   'seed'),
  ('INSULIN_BASAL', 'SULFONYLUREA', 'moderate',
   'Hypoglycaemia, especially overnight. Common and often intended — reduce the sulfonylurea as insulin goes up.',
   'seed'),
  ('INSULIN_PREMIX', 'SULFONYLUREA', 'moderate',
   'Hypoglycaemia, especially overnight. Common and often intended — reduce the sulfonylurea as insulin goes up.',
   'seed'),
  ('DPP4I', 'GLP1', 'moderate',
   'Same incretin pathway — no added glycaemic benefit from both. Stop the DPP4 inhibitor when starting a GLP-1.',
   'seed'),
  ('LOOP_DIURETIC', 'SGLT2I', 'moderate',
   'Volume depletion and hypotension, worst in the first weeks. Consider halving the diuretic and reviewing in two weeks.',
   'seed'),
  ('DIURETIC', 'SGLT2I', 'moderate',
   'Volume depletion and hypotension, worst in the first weeks. Consider halving the diuretic and reviewing in two weeks.',
   'seed'),
  ('ACEI', 'NSAID', 'moderate',
   'Blunts the blood-pressure effect and risks kidney injury — the worse if a diuretic is also on the list.',
   'seed'),
  ('ARB', 'NSAID', 'moderate',
   'Blunts the blood-pressure effect and risks kidney injury — the worse if a diuretic is also on the list.',
   'seed'),
  ('DIURETIC', 'NSAID', 'moderate',
   'Kidney injury when combined with an ACE inhibitor or ARB — the "triple whammy". Check what else is on the list.',
   'seed'),
  ('LOOP_DIURETIC', 'NSAID', 'moderate',
   'Kidney injury when combined with an ACE inhibitor or ARB — the "triple whammy". Check what else is on the list.',
   'seed'),
  ('ANTIPLATELET', 'NSAID', 'moderate',
   'Gastrointestinal bleeding. Add gastroprotection, or use paracetamol instead.',
   'seed'),
  ('CORTICOSTEROID', 'NSAID', 'moderate',
   'Gastric ulceration. Add gastroprotection if both are needed.',
   'seed'),
  ('ANTIPLATELET', 'PPI', 'moderate',
   'Omeprazole and esomeprazole reduce the effect of clopidogrel. Pantoprazole does not — switch if the antiplatelet is clopidogrel.',
   'seed'),
  ('FIBRATE', 'STATIN', 'moderate',
   'Myopathy, and rarely rhabdomyolysis. Fenofibrate is the safer partner; warn the patient about muscle pain.',
   'seed'),
  ('ANTIFUNGAL', 'STATIN', 'moderate',
   'Oral azoles raise statin levels and risk myopathy. Applies to the tablet, not a topical cream — hold the statin for a short oral course.',
   'seed'),
  ('MACROLIDE', 'STATIN', 'moderate',
   'Clarithromycin raises statin levels and risks myopathy. Hold the statin for the course, or use azithromycin.',
   'seed'),
  ('IRON', 'THYROID', 'moderate',
   'Iron blocks thyroxine absorption. Separate the doses by four hours.',
   'seed'),
  ('CALCIUM', 'THYROID', 'moderate',
   'Calcium blocks thyroxine absorption. Separate the doses by four hours.',
   'seed'),
  ('ANTACID', 'THYROID', 'moderate',
   'Antacids block thyroxine absorption. Separate the doses by four hours.',
   'seed'),
  ('BETA_BLOCKER', 'CCB', 'moderate',
   'Only with a rate-limiting CCB (verapamil, diltiazem): bradycardia and heart block. Safe with amlodipine — check which CCB this is.',
   'seed'),
  ('ALPHA_BLOCKER', 'PDE5I', 'moderate',
   'Postural hypotension. Separate the doses by four hours and start at the lowest dose.',
   'seed'),
  ('BENZODIAZEPINE', 'GABAPENTINOID', 'moderate',
   'Additive sedation and respiratory depression, worse in the elderly. Avoid the pair or reduce both.',
   'seed'),
  ('BENZODIAZEPINE', 'HYPNOTIC', 'moderate',
   'Additive sedation. Prescribe one, and review whether it is still needed.',
   'seed'),
  -- Duplication rules: class_a = class_b. Anything not listed here is caught by
  -- the default duplication rule in the service, at moderate.
  ('ACEI', 'ACEI', 'severe',
   'Two ACE inhibitors — a doubled dose. Almost always one of them should have been stopped.',
   'seed'),
  ('ARB', 'ARB', 'severe',
   'Two ARBs — a doubled dose, and often one is hidden inside a combination tablet.',
   'seed'),
  ('BIGUANIDE', 'BIGUANIDE', 'severe',
   'Two metformins — usually a brand and a combination tablet containing the same drug. Check the total daily dose.',
   'seed'),
  ('SULFONYLUREA', 'SULFONYLUREA', 'severe',
   'Two sulfonylureas — hypoglycaemia, and no added benefit. Keep one.',
   'seed'),
  ('STATIN', 'STATIN', 'severe',
   'Two statins — no added benefit, and additive myopathy risk. Keep one.',
   'seed'),
  ('NSAID', 'NSAID', 'severe',
   'Two NSAIDs — additive gastrointestinal and kidney risk, with no added analgesia.',
   'seed'),
  ('ANTICOAGULANT', 'ANTICOAGULANT', 'severe',
   'Two anticoagulants — a serious bleeding risk. This is a reconciliation error until proven otherwise.',
   'seed'),
  ('ANTIPLATELET', 'ANTIPLATELET', 'severe',
   'Dual antiplatelet therapy. Deliberate after a stent, and then for a defined period — record the period.',
   'seed'),
  ('GABAPENTINOID', 'GABAPENTINOID', 'severe',
   'Two gabapentinoids — additive sedation with no added benefit. Keep one.',
   'seed'),
  ('THYROID', 'THYROID', 'severe',
   'Two thyroxine products — a doubled dose. Check the strength of each.',
   'seed')
ON CONFLICT (class_a, class_b) DO NOTHING;

COMMENT ON TABLE giniflow_interaction_rules IS
  'Class-pair interaction rules read by services/giniflow/interactions.js. class_a = class_b is a duplication rule. Clinical content: editable without a deploy.';
COMMENT ON TABLE giniflow_interaction_acks IS
  'A severe interaction prescribed deliberately, with the reason and who gave it. One row per visit per rule.';
