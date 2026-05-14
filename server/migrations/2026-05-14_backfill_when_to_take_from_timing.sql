-- Backfill medications.when_to_take from the legacy `timing` free-text column,
-- using ONLY exact matches against the when_to_take_pill ENUM. Anything in
-- `timing` that doesn't map to a canonical pill is left in `timing` as-is.
--
-- Requires:
--   * when_to_take_pill ENUM type
--   * medications.when_to_take is when_to_take_pill[]
--   * cast_when_to_take_token(TEXT) helper
--   (all created by 2026-05-14_medications_when_to_take_enum.sql)
--
-- Idempotent: rows where the computed array already matches when_to_take
-- (or where no canonical tokens were found) are not touched.

UPDATE medications m
   SET when_to_take = sub.arr
  FROM (
    SELECT m.id,
           ARRAY(
             SELECT DISTINCT cast_when_to_take_token(tok)
               FROM unnest(string_to_array(m.timing, ',')) AS tok
              WHERE cast_when_to_take_token(tok) IS NOT NULL
           ) AS arr
      FROM medications m
     WHERE m.timing IS NOT NULL
       AND m.timing <> ''
  ) sub
 WHERE m.id = sub.id
   AND array_length(sub.arr, 1) IS NOT NULL          -- skip rows with no canonical hits
   AND (m.when_to_take IS NULL OR m.when_to_take <> sub.arr);

-- How many rows now have at least one canonical pill set vs. left empty?
SELECT
  COUNT(*) FILTER (WHERE when_to_take IS NOT NULL AND array_length(when_to_take, 1) > 0) AS with_pills,
  COUNT(*) FILTER (WHERE when_to_take IS NULL OR array_length(when_to_take, 1) IS NULL)  AS still_empty,
  COUNT(*) FILTER (WHERE timing IS NOT NULL AND timing <> '')                            AS rows_with_timing,
  COUNT(*)                                                                                AS total_rows
  FROM medications;
