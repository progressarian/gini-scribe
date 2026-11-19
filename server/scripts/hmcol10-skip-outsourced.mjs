import "../loadEnv.js";
import pool from "../config/db.js";
import { updateDiscountRule } from "../services/billing/discountRules.js";

const APPLY = process.argv.includes("--apply");

try {
  const { rows } = await pool.query(
    `SELECT id, code, group_ids, applies_per, is_active, excludes_outsourced
       FROM discount_rules WHERE code = 'HMCOL10'`,
  );
  console.log("before", rows[0]);
  if (rows.length !== 1 || rows[0].id !== 12) throw new Error("Unexpected rule, nothing changed");
  if (rows[0].excludes_outsourced) {
    console.log("Already skips outsourced tests");
  } else if (!APPLY) {
    console.log("Dry run, pass --apply to write");
  } else {
    const rule = await updateDiscountRule(12, { excludes_outsourced: true }, { actorId: null });
    console.log("after", {
      id: rule.id,
      code: rule.code,
      excludes_outsourced: rule.excludes_outsourced,
    });
  }
} finally {
  await pool.end();
}
