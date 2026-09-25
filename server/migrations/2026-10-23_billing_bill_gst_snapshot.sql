ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS issued_gst        BOOLEAN,
  ADD COLUMN IF NOT EXISTS issued_gstin      TEXT,
  ADD COLUMN IF NOT EXISTS issued_legal_name TEXT;

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS bills_issued_gst_draft_check,
  ADD CONSTRAINT bills_issued_gst_draft_check
    CHECK (status <> 'draft' OR (issued_gst IS NULL AND issued_gstin IS NULL
           AND issued_legal_name IS NULL));

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS bills_issued_gst_details_check,
  ADD CONSTRAINT bills_issued_gst_details_check
    CHECK (issued_gst IS TRUE OR (issued_gstin IS NULL AND issued_legal_name IS NULL));

WITH issued AS (
  SELECT b.id,
         b.tax_amount,
         COALESCE(
           (SELECT a.after FROM billing_audit a
             WHERE a.entity = 'billing_settings' AND a.at <= b.finalised_at
             ORDER BY a.at DESC, a.id DESC LIMIT 1),
           (SELECT a.before FROM billing_audit a
             WHERE a.entity = 'billing_settings' AND a.at > b.finalised_at
             ORDER BY a.at, a.id LIMIT 1),
           (SELECT to_jsonb(s) FROM billing_settings s LIMIT 1)
         ) AS settings
    FROM bills b
   WHERE b.bill_type = 'invoice' AND b.status <> 'draft' AND b.issued_gst IS NULL
     AND b.finalised_at IS NOT NULL
), decided AS (
  SELECT id, settings,
         COALESCE((settings->>'gst_enabled')::boolean, FALSE) OR tax_amount > 0 AS gst
    FROM issued
)
UPDATE bills b
   SET issued_gst = d.gst,
       issued_gstin = CASE WHEN d.gst THEN d.settings->>'gstin' END,
       issued_legal_name = CASE WHEN d.gst THEN d.settings->>'legal_name' END
  FROM decided d
 WHERE b.id = d.id;

UPDATE bills n
   SET issued_gst = o.issued_gst,
       issued_gstin = o.issued_gstin,
       issued_legal_name = o.issued_legal_name
  FROM bills o
 WHERE n.bill_type = 'credit_note' AND n.original_bill_id = o.id
   AND n.issued_gst IS NULL AND o.issued_gst IS NOT NULL;
