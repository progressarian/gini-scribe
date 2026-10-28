import "../loadEnv.js";
import pool from "../config/db.js";
import { updateDiscountRule } from "../services/billing/discountRules.js";

try {
  const { rows } = await pool.query(
    `SELECT id, code, group_ids FROM discount_rules WHERE code = 'HMCOL10'`,
  );
  const { rows: groups } = await pool.query(
    `SELECT id, name FROM service_groups WHERE code = 'LAB'`,
  );
  console.log("before", rows[0], "group", groups[0]);
  if (rows[0]?.id !== 12 || groups[0]?.id !== 7) throw new Error("Unexpected ids, nothing changed");
  const rule = await updateDiscountRule(12, { group_ids: [7] }, { actorId: null });
  console.log("after", {
    id: rule.id,
    code: rule.code,
    group_ids: rule.group_ids,
    is_active: rule.is_active,
    value: rule.value,
  });
} finally {
  await pool.end();
}
