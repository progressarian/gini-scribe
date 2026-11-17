DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pharmacy_vendors', 'pharmacy_medicines', 'pharmacy_locations', 'pharmacy_location_levels',
    'pharmacy_settings', 'pharmacy_batches', 'pharmacy_stock', 'pharmacy_stock_movements',
    'pharmacy_purchases', 'pharmacy_purchase_lines', 'pharmacy_stock_adjustments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END;
$$;
