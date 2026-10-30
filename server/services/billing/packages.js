import { paise } from "../../../shared/labPayment.js";

const PACKAGES_SQL = `
  SELECT p.id, p.name, p.base_price, array_agg(pp.part_item_id ORDER BY pp.part_item_id) AS parts
    FROM service_items p
    JOIN service_item_package_parts pp ON pp.package_item_id = p.id
    JOIN service_items part ON part.id = pp.part_item_id AND part.is_active
   WHERE p.is_active
   GROUP BY p.id
  HAVING count(*) = (SELECT count(*) FROM service_item_package_parts x WHERE x.package_item_id = p.id)`;

const largestFirst = (a, b) => b.parts.length - a.parts.length || b.price - a.price || a.id - b.id;

export async function activePackages(db) {
  const { rows } = await db.query(PACKAGES_SQL);
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      price: paise(row.base_price),
      parts: row.parts.map(Number),
    }))
    .filter((pkg) => pkg.parts.length > 1)
    .sort(largestFirst);
}

export function choosePackages(packages, lines, eligible = () => true) {
  const claimed = new Set();
  const groups = [];
  for (const pkg of packages) {
    const scope = [];
    for (const itemId of pkg.parts) {
      const index = lines.findIndex(
        (line, at) =>
          line.item_id === itemId && !claimed.has(at) && !scope.includes(at) && eligible(line),
      );
      if (index === -1) break;
      scope.push(index);
    }
    if (scope.length !== pkg.parts.length) continue;
    scope.forEach((index) => claimed.add(index));
    groups.push({ package: pkg, scope });
  }
  return groups;
}

export function listPriceOf(packages, parts) {
  const groups = choosePackages(
    packages,
    parts.map((part) => ({ item_id: part.item_id })),
  );
  const inGroup = new Set(groups.flatMap((group) => group.scope));
  return (
    groups.reduce((sum, group) => sum + group.package.price, 0) +
    parts.reduce((sum, part, index) => sum + (inGroup.has(index) ? 0 : part.base), 0)
  );
}

const SUMMED = [
  "actual",
  "discount",
  "taxable",
  "cgst",
  "sgst",
  "tax",
  "patient_payable",
  "claim",
  "adjustment",
];

export async function withPrintedPackages(db, lines) {
  const ids = [...new Set(lines.map((line) => line.package_item_id).filter(Boolean))];
  if (!ids.length) return lines;
  const { rows } = await db.query(
    `SELECT package_item_id, array_agg(part_item_id) AS parts
       FROM service_item_package_parts WHERE package_item_id = ANY($1::int[])
      GROUP BY package_item_id`,
    [ids],
  );
  const partsOf = new Map(rows.map((row) => [row.package_item_id, row.parts.map(Number)]));
  const whole = (id) => {
    const items = lines
      .filter((line) => line.package_item_id === id)
      .map((line) => line.service_item_id)
      .sort((a, b) => a - b);
    const parts = [...(partsOf.get(id) ?? [])].sort((a, b) => a - b);
    return parts.length > 1 && items.join(",") === parts.join(",");
  };
  const printed = [];
  const seen = new Set();
  for (const line of lines) {
    const id = line.package_item_id;
    if (!id || !whole(id)) {
      printed.push(line);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const group = lines.filter((part) => part.package_item_id === id);
    printed.push({
      ...line,
      bill_name: line.package_name ?? line.bill_name,
      bill_code: null,
      item_code: null,
      quantity: 1,
      rate: group.reduce((sum, part) => sum + Math.round(part.rate * Number(part.quantity)), 0),
      ...Object.fromEntries(
        SUMMED.map((key) => [key, group.reduce((sum, part) => sum + (part[key] ?? 0), 0)]),
      ),
    });
  }
  return printed;
}
