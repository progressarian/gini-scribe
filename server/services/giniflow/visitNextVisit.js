import pool from "../../config/db.js";

const NEXT_VISIT_SQL = `
  SELECT cp.next_visit_date::text AS date,
         NULLIF(btrim(cp.next_visit_interval), '') AS timing,
         ARRAY(
           SELECT t.test_name
             FROM giniflow_lab_orders o
             JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
            WHERE o.visit_id = v.id AND o.urgency = 'next_visit'
            ORDER BY o.created_at, t.test_name
         ) AS tests
    FROM giniflow_visits v
    LEFT JOIN giniflow_care_plans cp ON cp.visit_id = v.id
   WHERE v.appointment_id = $1
   ORDER BY v.created_at DESC
   LIMIT 1`;

export async function appointmentNextVisit(appointmentId, db = pool) {
  if (!appointmentId) return null;
  const { rows } = await db.query(NEXT_VISIT_SQL, [appointmentId]).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row) return null;
  const tests = [...new Set((row.tests || []).map((t) => String(t).trim()).filter(Boolean))];
  if (!row.date && !row.timing && !tests.length) return null;
  return {
    followUp: row.date || row.timing ? { date: row.date, timing: row.timing } : null,
    tests: tests.map((name) => ({ name, urgency: "next_visit" })),
  };
}
