-- Patient-initiated lab test bookings (from the myhealthgenie app). Doctor
-- reviews on the LabRequests page and approves/rejects. Home-collection
-- requests must carry a 4-part address; the CHECK constraint enforces this
-- even if the API layer is bypassed.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS lab_test_requests (
  id                SERIAL PRIMARY KEY,
  patient_id        INTEGER NOT NULL REFERENCES patients(id),
  test_names        TEXT[] NOT NULL,
  collection_type   TEXT NOT NULL CHECK (collection_type IN ('hospital','home')),
  address_house     TEXT,
  address_street    TEXT,
  address_landmark  TEXT,
  address_pincode   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT lab_request_home_needs_address CHECK (
    collection_type <> 'home'
    OR (
      address_house    IS NOT NULL AND length(trim(address_house))    > 0
      AND address_street  IS NOT NULL AND length(trim(address_street))   > 0
      AND address_landmark IS NOT NULL AND length(trim(address_landmark)) > 0
      AND address_pincode ~ '^[0-9]{6}$'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_labreq_patient
  ON lab_test_requests(patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_labreq_status
  ON lab_test_requests(status, created_at DESC);
