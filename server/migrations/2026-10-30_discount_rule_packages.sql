ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS requires_all_items BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE discount_rules DROP CONSTRAINT IF EXISTS discount_rules_bill_fixed_price_check;
ALTER TABLE discount_rules
  ADD CONSTRAINT discount_rules_bill_fixed_price_check
  CHECK (kind <> 'fixed_price' OR applies_per <> 'bill' OR requires_all_items);

ALTER TABLE discount_rules DROP CONSTRAINT IF EXISTS discount_rules_package_check;
ALTER TABLE discount_rules
  ADD CONSTRAINT discount_rules_package_check
  CHECK (
    NOT requires_all_items
    OR (applies_per = 'bill' AND method = 'auto'
        AND cardinality(service_item_ids) >= 2
        AND group_ids IS NULL AND subgroup_ids IS NULL)
  );
