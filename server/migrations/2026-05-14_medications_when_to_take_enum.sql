-- Convert medications.when_to_take from TEXT (comma-separated) to
-- when_to_take_pill[] (native Postgres array of an ENUM). Some medicines
-- need to be taken at multiple times (e.g. After breakfast + After dinner),
-- so an array column is the natural shape — one element per pill.
--
-- Idempotent: safe to re-run. Each step inspects the current state and
-- skips work that's already done, so partial runs recover cleanly.

-- 1. ENUM type — the 11 canonical pill labels.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'when_to_take_pill') THEN
    CREATE TYPE when_to_take_pill AS ENUM (
      'Fasting',
      'Before breakfast',
      'After breakfast',
      'Before lunch',
      'After lunch',
      'Before dinner',
      'After dinner',
      'At bedtime',
      'With milk',
      'SOS only',
      'Any time'
    );
  END IF;
END$$;

-- 2. Helper that turns a single freeform token into a valid enum value or
--    NULL. Exact-match only — fuzzy mapping lives in the JS backfill script.
CREATE OR REPLACE FUNCTION cast_when_to_take_token(tok TEXT)
RETURNS when_to_take_pill
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  BEGIN
    RETURN btrim(tok)::when_to_take_pill;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END$$;

-- 3. Convert only if when_to_take is still TEXT. If it's already the
--    enum-array type (because a previous run completed the swap) this
--    whole block is a no-op.
DO $$
DECLARE
  current_type TEXT;
BEGIN
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod)
    INTO current_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'medications'
     AND a.attname = 'when_to_take'
     AND NOT a.attisdropped;

  IF current_type IS NULL THEN
    -- Column doesn't exist yet — fresh DB. Just add the array column.
    EXECUTE 'ALTER TABLE medications ADD COLUMN when_to_take when_to_take_pill[]';
    RETURN;
  END IF;

  IF current_type = 'when_to_take_pill[]' THEN
    -- Already migrated. Nothing to do.
    RAISE NOTICE 'medications.when_to_take is already when_to_take_pill[] — skipping convert';
    RETURN;
  END IF;

  IF current_type = 'text' THEN
    RAISE NOTICE 'Converting medications.when_to_take from TEXT to when_to_take_pill[]';

    -- Staging column. IF NOT EXISTS so a partial earlier run is fine.
    ALTER TABLE medications ADD COLUMN IF NOT EXISTS when_to_take_arr when_to_take_pill[];

    -- Backfill: split the TEXT column on commas, cast each token, drop
    -- invalid ones, NULL out empty results.
    UPDATE medications
       SET when_to_take_arr = NULLIF(sub.arr, ARRAY[]::when_to_take_pill[])
      FROM (
        SELECT m.id,
               ARRAY(
                 SELECT cast_when_to_take_token(tok)
                   FROM unnest(string_to_array(m.when_to_take, ',')) AS tok
                  WHERE cast_when_to_take_token(tok) IS NOT NULL
               ) AS arr
          FROM medications m
         WHERE m.when_to_take IS NOT NULL AND m.when_to_take <> ''
      ) sub
     WHERE medications.id = sub.id;

    -- Swap: drop the old TEXT column, promote the array column.
    ALTER TABLE medications DROP COLUMN when_to_take;
    ALTER TABLE medications RENAME COLUMN when_to_take_arr TO when_to_take;
    RETURN;
  END IF;

  RAISE EXCEPTION
    'medications.when_to_take has unexpected type %, cannot auto-migrate', current_type;
END$$;

-- 4. Defensive cleanup: if a previous failed run left when_to_take_arr
--    sitting alongside the now-renamed canonical column, drop the stray.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'medications' AND column_name = 'when_to_take_arr'
  ) THEN
    ALTER TABLE medications DROP COLUMN when_to_take_arr;
  END IF;
END$$;
