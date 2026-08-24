INSERT INTO corporate_companies (slug, name, contact_email)
VALUES ('synvesia', 'Synvesia', NULL)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW();

INSERT INTO corporate_packages (company_id, name, description, sort_order)
SELECT id, '40+ Health Checkup Package', NULL, 0
FROM corporate_companies WHERE slug = 'synvesia'
ON CONFLICT (company_id, name) DO UPDATE SET updated_at = NOW();

INSERT INTO corporate_package_tests (package_id, test_name, precaution_note, sort_order)
SELECT p.id, t.test_name, NULL, t.sort_order
FROM corporate_packages p
JOIN corporate_companies c ON c.id = p.company_id
CROSS JOIN (VALUES
  ('ECG', 0),
  ('Echo', 1),
  ('Blood Tests', 2)
) AS t(test_name, sort_order)
WHERE c.slug = 'synvesia' AND p.name = '40+ Health Checkup Package'
ON CONFLICT (package_id, test_name) DO NOTHING;
