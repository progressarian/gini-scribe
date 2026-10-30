CREATE TABLE IF NOT EXISTS service_item_package_parts (
  package_item_id INT NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  part_item_id INT NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  PRIMARY KEY (package_item_id, part_item_id),
  CHECK (package_item_id <> part_item_id)
);

ALTER TABLE bill_lines
  ADD COLUMN IF NOT EXISTS package_item_id INT REFERENCES service_items(id) ON DELETE SET NULL;

INSERT INTO service_item_package_parts (package_item_id, part_item_id)
SELECT pkg.id, part.id
  FROM (VALUES
          ('MAC-PKG-ABI-VPT-FUNDUS', 'MAC-ABI'),
          ('MAC-PKG-ABI-VPT-FUNDUS', 'MAC-VPT'),
          ('MAC-PKG-ABI-VPT-FUNDUS', 'MAC-FUNDUS'),
          ('MAC-PKG-ABI-VPT', 'MAC-ABI'),
          ('MAC-PKG-ABI-VPT', 'MAC-VPT')
       ) AS seed(package_code, part_code)
  JOIN service_items pkg ON lower(pkg.code) = lower(seed.package_code)
  JOIN service_items part ON lower(part.code) = lower(seed.part_code)
ON CONFLICT DO NOTHING;

UPDATE service_items SET name = 'ABI,VPT,Fundus', updated_at = NOW()
 WHERE lower(code) = lower('MAC-PKG-ABI-VPT-FUNDUS') AND name <> 'ABI,VPT,Fundus';

UPDATE service_items SET name = 'ABI,VPT', updated_at = NOW()
 WHERE lower(code) = lower('MAC-PKG-ABI-VPT') AND name <> 'ABI,VPT';
