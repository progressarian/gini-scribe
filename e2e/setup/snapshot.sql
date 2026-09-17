DROP TABLE IF EXISTS public.e2e_reference_snapshot;

CREATE TABLE public.e2e_reference_snapshot (
  table_name text PRIMARY KEY,
  data jsonb NOT NULL
);

DO $$
DECLARE
  t record;
  rows jsonb;
BEGIN
  FOR t IN
    SELECT format('%I.%I', schemaname, tablename) AS name
      FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'e2e_reference_snapshot'
  LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(x)) FROM %s x', t.name) INTO rows;
    IF rows IS NOT NULL THEN
      INSERT INTO public.e2e_reference_snapshot (table_name, data) VALUES (t.name, rows);
    END IF;
  END LOOP;
END
$$;
