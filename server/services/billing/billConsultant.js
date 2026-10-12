import pool from "../../config/db.js";
import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";
import { labOnlyPredicate } from "../giniflow/labOnlyVisits.js";
import { httpError } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LAB_ONLY = `'${LAB_ONLY_DOCTOR.replace(/'/g, "''")}'`;

export const HOSPITAL_ADMIN_ID_SQL = `(SELECT ha.id FROM doctors ha
  WHERE lower(btrim(ha.name)) = lower(${LAB_ONLY})
  ORDER BY ha.is_active IS NOT FALSE DESC, ha.id LIMIT 1)`;

export const TESTS_ONLY_CONSULTANT_SQL = (a = "a") =>
  `(CASE WHEN lower(btrim(${a}.doctor_name)) = lower(${LAB_ONLY}) THEN ${HOSPITAL_ADMIN_ID_SQL} END)`;

export const BILL_CONSULTANT_SQL = (b = "b") => `COALESCE(
  ${b}.consultant_id,
  (SELECT ob.consultant_id FROM bills ob WHERE ob.id = ${b}.original_bill_id),
  (SELECT cl.doctor_id FROM bill_lines cl
     JOIN service_items ci ON ci.id = cl.service_item_id
    WHERE cl.bill_id = COALESCE(${b}.original_bill_id, ${b}.id)
      AND cl.is_live AND ci.kind = 'consultation' AND cl.doctor_id IS NOT NULL
    ORDER BY cl.line_no LIMIT 1),
  (SELECT COALESCE(cv.assigned_doctor_id, ca.doctor_id,
                   (SELECT cd.id FROM doctors cd
                     WHERE lower(btrim(cd.name)) = lower(btrim(ca.doctor_name))
                       AND cd.role = 'consultant'
                     ORDER BY cd.is_active IS NOT FALSE DESC, cd.id LIMIT 1))
     FROM giniflow_visits cv
     LEFT JOIN appointments ca ON ca.id = cv.appointment_id
    WHERE cv.id = ${b}.visit_id AND NOT ${labOnlyPredicate("cv", LAB_ONLY)}),
  ${HOSPITAL_ADMIN_ID_SQL})`;

const shapeDoctor = (row) => (row ? { id: row.id, name: row.name } : null);

export async function hospitalAdmin(db = pool) {
  const { rows } = await db.query(
    `SELECT id, name FROM doctors WHERE id = ${HOSPITAL_ADMIN_ID_SQL}`,
  );
  return shapeDoctor(rows[0]);
}

export async function billConsultantOf(db, billId) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, (b.consultant_id IS NOT NULL) AS chosen,
            (d.id = ${HOSPITAL_ADMIN_ID_SQL}) AS tests_only
       FROM bills b
       JOIN doctors d ON d.id = ${BILL_CONSULTANT_SQL("b")}
      WHERE b.id = $1`,
    [billId],
  );
  return rows[0]
    ? { ...shapeDoctor(rows[0]), chosen: rows[0].chosen, tests_only: rows[0].tests_only }
    : null;
}

export async function consultantOptions(billId, db = pool) {
  if (!UUID.test(String(billId || ""))) throw httpError(404, "That bill no longer exists");
  const { rows: today } = await db.query(
    `SELECT DISTINCT d.id, d.name
       FROM bills b
       JOIN giniflow_visits v ON v.id = b.visit_id
       LEFT JOIN appointments a
              ON a.patient_id = v.patient_id AND a.appointment_date = v.visit_date
             AND a.status NOT IN ('cancelled', 'no_show')
       JOIN doctors d
         ON d.role = 'consultant' AND COALESCE(d.is_active, TRUE)
        AND (d.id = v.assigned_doctor_id OR d.id = a.doctor_id
             OR lower(btrim(d.name)) = lower(btrim(a.doctor_name)))
      WHERE b.id = $1 AND d.id IS DISTINCT FROM ${HOSPITAL_ADMIN_ID_SQL}
      ORDER BY d.name`,
    [billId],
  );
  const todayIds = today.map((d) => d.id);
  const { rows: others } = await db.query(
    `SELECT id, name FROM doctors
      WHERE role = 'consultant' AND COALESCE(is_active, TRUE)
        AND id IS DISTINCT FROM ${HOSPITAL_ADMIN_ID_SQL}
        AND NOT (id = ANY($1::int[]))
      ORDER BY name`,
    [todayIds],
  );
  return {
    today: today.map(shapeDoctor),
    others: others.map(shapeDoctor),
    hospital_admin: await hospitalAdmin(db),
  };
}
