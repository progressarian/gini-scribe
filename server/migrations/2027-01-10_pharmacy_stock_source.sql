ALTER TABLE pharmacy_settings
  ADD COLUMN IF NOT EXISTS stock_source TEXT NOT NULL DEFAULT 'darpan'
    CHECK (stock_source IN ('darpan', 'scribe'));
