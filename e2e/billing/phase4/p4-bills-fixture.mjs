import crypto from "node:crypto";
import { one, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { e2eValues } from "../../setup/testEnv.mjs";

if (!process.env.AADHAAR_ENCRYPTION_KEY) {
  process.env.AADHAAR_ENCRYPTION_KEY = e2eValues().AADHAAR_ENCRYPTION_KEY ?? "";
}

export const newTag = () => crypto.randomBytes(3).toString("hex");

export const desk = { actorId: USERS.reception.id, ip: "10.9.4.1", role: "reception" };

export const failure = (promise) => promise.then(() => null).catch((error) => error);

export async function refused(promise, status, message, label) {
  const error = await failure(promise);
  if (!error) throw new Error(`${label}: it was allowed, and should not have been`);
  if (error.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${error.status} — ${error.message}`);
  }
  if (message && !message.test(error.message)) {
    throw new Error(`${label}: "${error.message}" does not match ${message}`);
  }
  return error;
}

const financialYear = (date) => {
  const [year, month] = date.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};

export async function today() {
  const { rows } = await query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`);
  return rows[0].d;
}

async function scheme(code, label, extra = {}) {
  const columns = {
    code,
    label,
    parent_code: null,
    payer_name: null,
    requires_ref: false,
    requires_referral: false,
    requires_referral_doc: false,
    allow_pay_later: null,
    ...extra,
  };
  const keys = Object.keys(columns);
  await query(
    `INSERT INTO patient_schemes (${keys.join(", ")})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((key) => columns[key]),
  );
  return code;
}

export async function setUp(tag, { visitType = "New Patient" } = {}) {
  await sweep();
  const ids = { tag };
  ids.day = await today();
  ids.fy = financialYear(ids.day);

  ids.parent = await scheme(`p4cghs-${tag}`, `P4 CGHS ${tag}`, { payer_name: `CGHS ${tag}` });
  ids.paid = await scheme(`p4paid-${tag}`, "Paid", { parent_code: ids.parent });
  ids.referral = await scheme(`p4ref-${tag}`, "Referral", {
    parent_code: ids.parent,
    requires_referral: true,
    requires_referral_doc: true,
  });
  ids.pensioner = await scheme(`p4pens-${tag}`, "Pensioner", { parent_code: ids.parent });

  ids.group = (
    await one(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
      `P4G-${tag}`,
      `P4 Group ${tag}`,
    ])
  ).id;
  ids.subgroup = (
    await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
      [ids.group, `P4S-${tag}`, `P4 Subgroup ${tag}`],
    )
  ).id;

  const item = async (code, name, price, extra = {}) => {
    const columns = {
      code: `${code}-${tag}`,
      name: `${name} ${tag}`,
      subgroup_id: ids.subgroup,
      base_price: price,
      kind: "procedure",
      ...extra,
    };
    const keys = Object.keys(columns);
    return (
      await one(
        `INSERT INTO service_items (${keys.join(", ")})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        keys.map((key) => columns[key]),
      )
    ).id;
  };

  ids.consultNew = await item("P4-CN", "Consultation New", 1500, {
    kind: "consultation",
    visit_type: "New",
  });
  ids.consultFu = await item("P4-CF", "Consultation Follow Up", 1000, {
    kind: "consultation",
    visit_type: "Follow Up",
  });
  ids.consultDoctorNew = await item("P4-CDN", "Consultation Dr New", 2000, {
    kind: "consultation",
    visit_type: "New",
    doctor_id: CONSULTANTS.banshali.id,
  });
  ids.dressing = await item("P4-DR", "Dressing", 500, { allow_quantity: true, max_quantity: 3 });
  ids.brace = await item("P4-BR", "Ankle brace", 800);

  const catalogue = async (name, category, price) =>
    (
      await one(
        `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, $2, $3)
         RETURNING id`,
        [`${name} ${tag}`, price, category],
      )
    ).id;
  ids.hba1cTest = await catalogue("P4 HbA1c", "lab", 250);
  ids.abiTest = await catalogue("P4 ABI", "machine", 400);
  ids.looseTest = await catalogue("P4 Loose", "lab", 300);
  ids.hba1cName = `P4 HbA1c ${tag}`;
  ids.abiName = `P4 ABI ${tag}`;
  ids.looseName = `P4 Loose ${tag}`;
  ids.hba1c = await item("P4-HB", "HbA1c", 250, { kind: "test", test_catalog_id: ids.hba1cTest });
  ids.abi = await item("P4-ABI", "ABI", 400, { kind: "test", test_catalog_id: ids.abiTest });

  ids.patient = (
    await one(
      `INSERT INTO patients (name, file_no, age, sex, scheme_code) VALUES ($1, $2, 55, 'Male', $3)
       RETURNING id`,
      [`P4 Patient ${tag}`, `F4-${tag}`, null],
    )
  ).id;
  ids.appointment = (
    await one(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_id, doctor_name)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7) RETURNING id`,
      [
        ids.patient,
        `P4 Patient ${tag}`,
        `F4-${tag}`,
        ids.day,
        visitType,
        CONSULTANTS.banshali.id,
        CONSULTANTS.banshali.name,
      ],
    )
  ).id;
  ids.visit = (
    await one(
      `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, assigned_doctor_id)
       VALUES ($1, $2::date, $3, $4) RETURNING id`,
      [ids.patient, ids.day, ids.appointment, CONSULTANTS.banshali.id],
    )
  ).id;

  const series = async (name, prefix) => {
    const { rowCount } = await query(
      `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
       VALUES ($1, $2, $3, 6, 1) ON CONFLICT (series, fy) DO NOTHING`,
      [name, ids.fy, prefix],
    );
    return {
      owns: rowCount === 1,
      prefix: (
        await one(`SELECT prefix FROM bill_series WHERE series = $1 AND fy = $2`, [name, ids.fy])
      ).prefix,
    };
  };
  const main = await series("MAIN", `P4${tag.toUpperCase()}/`);
  ids.ownsSeries = main.owns;
  ids.prefix = main.prefix;
  const receipt = await series("RCPT", `R4${tag.toUpperCase()}/`);
  ids.ownsReceiptSeries = receipt.owns;
  ids.receiptPrefix = receipt.prefix;
  return ids;
}

export async function subCategory(ids, label, extra = {}) {
  return scheme(`p4${label.toLowerCase()}-${ids.tag}`, label, {
    parent_code: ids.parent,
    ...extra,
  });
}

export async function extraVisit(
  ids,
  label,
  { visitType = "New Patient", doctorId = CONSULTANTS.banshali.id } = {},
) {
  const name = `P4 ${label} ${ids.tag}`;
  const fileNo = `F4${label}-${ids.tag}`;
  const patient = (
    await one(
      `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 55, 'Male') RETURNING id`,
      [name, fileNo],
    )
  ).id;
  const appointment = visitType
    ? (
        await one(
          `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date,
                                     visit_type, doctor_id)
           VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING id`,
          [patient, name, fileNo, ids.day, visitType, doctorId],
        )
      ).id
    : null;
  const visit = (
    await one(
      `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, assigned_doctor_id)
       VALUES ($1, $2::date, $3, $4) RETURNING id`,
      [patient, ids.day, appointment, doctorId],
    )
  ).id;
  return { patient, appointment, visit };
}

export async function payRule(ids, scheme_code, values) {
  const columns = {
    scheme_code,
    patient_pays: "full",
    patient_value: null,
    remainder: "claim",
    ...values,
    name: `P4 ${values.name ?? "rule"} ${ids.tag}`,
  };
  const keys = Object.keys(columns);
  return (
    await one(
      `INSERT INTO category_payment_rules (${keys.join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      keys.map((key) => columns[key]),
    )
  ).id;
}

export async function discountCode(ids, code, values = {}) {
  const columns = {
    code,
    name: `P4 ${code} ${ids.tag}`,
    method: "code",
    kind: "percent",
    value: 10,
    applies_per: "line",
    service_item_ids: null,
    ...values,
  };
  const keys = Object.keys(columns);
  return (
    await one(
      `INSERT INTO discount_rules (${keys.join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      keys.map((key) => columns[key]),
    )
  ).id;
}

export async function labOrder(ids, tests, kind = "lab") {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', 0, 'payment_pending', $2) RETURNING id`,
    [ids.visit, kind],
  );
  for (const name of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 0)`,
      [order.id, name],
    );
  }
  return order.id;
}

export async function sweep() {
  const patients = `SELECT id FROM patients WHERE name LIKE 'P4 %'`;
  const visits = `SELECT id FROM giniflow_visits WHERE patient_id IN (${patients})`;
  const bills = `SELECT id FROM bills WHERE patient_id IN (${patients})`;
  const lines = `SELECT id FROM bill_lines WHERE bill_id IN (${bills})`;
  await query(`DELETE FROM bill_line_discounts WHERE bill_line_id IN (${lines})`);
  await query(`DELETE FROM bill_lines WHERE bill_id IN (${bills})`);
  await query(`DELETE FROM payments WHERE bill_id IN (${bills})`);
  await query(
    `DELETE FROM billing_requests WHERE patient_id IN (${patients}) OR visit_id IN (${visits})`,
  );
  await query(`DELETE FROM bills WHERE patient_id IN (${patients})`);
  await query(`DELETE FROM giniflow_lab_orders WHERE visit_id IN (${visits})`);
  await query(`DELETE FROM giniflow_visit_events WHERE visit_id IN (${visits})`);
  await query(`DELETE FROM giniflow_visits WHERE patient_id IN (${patients})`);
  await query(`DELETE FROM appointments WHERE patient_id IN (${patients})`);
  await query(`DELETE FROM walkin_bookings WHERE patient_id IN (${patients})`).catch(() => {});
  await query(`DELETE FROM documents WHERE patient_id IN (${patients})`);
  await query(`DELETE FROM patients WHERE name LIKE 'P4 %'`);
  await query(`DELETE FROM discount_rules WHERE name LIKE 'P4 %'`);
  await query(
    `DELETE FROM category_payment_rules WHERE name LIKE 'P4 %' OR scheme_code LIKE 'p4%'`,
  );
  await query(`DELETE FROM service_items WHERE code LIKE 'P4-%'`);
  await query(`DELETE FROM giniflow_test_catalog WHERE test_name LIKE 'P4 %'`);
  await query(`DELETE FROM service_subgroups WHERE code LIKE 'P4S-%'`);
  await query(`DELETE FROM service_groups WHERE code LIKE 'P4G-%'`);
  await query(`DELETE FROM patient_schemes WHERE parent_code LIKE 'p4%'`);
  await query(`DELETE FROM patient_schemes WHERE code LIKE 'p4%'`);
}

export async function tearDown(ids) {
  await sweep();
  if (ids?.ownsSeries) {
    await query(`DELETE FROM bill_series WHERE series = 'MAIN' AND fy = $1`, [ids.fy]);
  }
  if (ids?.ownsReceiptSeries) {
    await query(`DELETE FROM bill_series WHERE series = 'RCPT' AND fy = $1`, [ids.fy]);
  }
}
