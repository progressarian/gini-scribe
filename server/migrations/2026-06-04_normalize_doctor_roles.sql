-- Normalize doctors.role to canonical lowercase values for RBAC.
--
-- The role column is free-text and had a mis-cased value ("MO") plus the
-- possibility of other stray casings. The application now keys capability
-- checks off canonical lowercase roles (see shared/permissions.js), so bring
-- the stored data in line. normalizeRole() in the app already fails unknown
-- roles closed to "guest", so this migration is purely a data tidy-up — it
-- does not add a hard CHECK constraint (which would block adding new roles
-- without a follow-up migration).

UPDATE doctors
   SET role = lower(role)
 WHERE role IS NOT NULL
   AND role <> lower(role);

-- Map any legacy alias to its canonical role (extend as needed).
UPDATE doctors SET role = 'consultant' WHERE lower(role) = 'md';

-- Sanity check (informational): list the distinct roles after normalization.
-- SELECT role, COUNT(*) FROM doctors GROUP BY role ORDER BY role;
