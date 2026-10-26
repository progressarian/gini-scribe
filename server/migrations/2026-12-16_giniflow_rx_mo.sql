ALTER TABLE giniflow_visits ADD COLUMN IF NOT EXISTS rx_mo_id INTEGER REFERENCES doctors(id);

CREATE INDEX IF NOT EXISTS idx_giniflow_visits_rx_mo
  ON giniflow_visits (rx_mo_id, visit_date)
  WHERE rx_mo_id IS NOT NULL;
