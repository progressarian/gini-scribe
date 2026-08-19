-- Plain btree on appointments.file_no.
-- Run manually against prod. CONCURRENTLY avoids blocking writes; the statement
-- must run outside a transaction block.
--
-- Rationale: the GHM sheet's "latest follow-up visit" and "already booked on this
-- date" checks join appointments to itself on file_no = file_no. The only equality
-- candidates today are the trgm GIN index (10ms per probe) and a partial composite
-- unique index Postgres cannot use here, so the by-date and follow-up listings pay
-- a bitmap scan per row. Measured on prod: count query 755ms → 339ms.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appt_file_no
  ON appointments (file_no);
