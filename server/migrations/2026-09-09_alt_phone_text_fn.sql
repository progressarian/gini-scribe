CREATE OR REPLACE FUNCTION alt_phone_text(p text[])
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  SELECT array_to_string(p, E'\n')
$$;
