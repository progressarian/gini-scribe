import crypto from "node:crypto";
import pg from "pg";
import { getPool, one, query } from "../../helpers/db.mjs";
import { TEST_DATABASE_URL } from "../../setup/guard.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";

export const newDayTag = () => crypto.randomBytes(3).toString("hex");

const LOCK = 4038;
const WAIT_MS = 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holders = new Map();

const financialYear = (date) => {
  const [year, month] = date.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};

async function hold(tag) {
  const holder = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await holder.connect();
  await holder.query(`SELECT pg_advisory_lock($1, hashtext($2))`, [LOCK, tag]);
  holders.set(tag, holder);
}

async function release(tag) {
  const holder = holders.get(tag);
  holders.delete(tag);
  await holder?.end().catch(() => {});
}

async function live(client, tag) {
  const { rows } = await client.query(`SELECT pg_try_advisory_lock($1, hashtext($2)) AS free`, [
    LOCK,
    tag,
  ]);
  if (!rows[0].free) return true;
  await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [LOCK, tag]);
  return false;
}

async function insert(table, columns, returning = "id") {
  const keys = Object.keys(columns);
  return one(
    `INSERT INTO ${table} (${keys.join(", ")})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${returning}`,
    keys.map((key) => columns[key]),
  );
}

async function retryOnConsultation(tag, make) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      return await make();
    } catch (error) {
      if (error.constraint !== "service_items_consultation_key" || Date.now() > deadline) {
        throw error;
      }
      await sweepAbandonedDays();
      await sleep(1000);
    }
  }
}

export const ROSTER = {
  rahul: CONSULTANTS.rahul,
  beant: CONSULTANTS.beant,
};

export const PRICES = {
  rahulNew: 1000,
  rahulFollowUp: 700,
  beantNew: 1200,
  beantFollowUp: 800,
  dressing: 300,
  hba1c: 450,
  lipid: 600,
  newItem: 350,
};

export async function ensureSeries(day) {
  for (const [name, prefix] of [
    ["MAIN", `FT${day.T}/`],
    ["RCPT", `FR${day.T}/`],
  ]) {
    await query(
      `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
       VALUES ($1, $2, $3, 6, 1) ON CONFLICT (series, fy) DO NOTHING`,
      [name, day.fy, prefix],
    );
  }
}

export async function seedDay(tag) {
  await hold(tag);
  try {
    await sweepAbandonedDays();
    await sweepDay(tag);
    return await build(tag);
  } catch (error) {
    await sweepDay(tag).catch(() => {});
    await release(tag);
    throw error;
  }
}

async function build(tag) {
  const T = tag.toUpperCase();
  const day = { tag, T, patients: {} };
  day.date = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
  day.fy = financialYear(day.date);

  day.settingsBefore = await one(
    `SELECT CASE WHEN legal_name ~ '\\(rehearsal [0-9a-f]{6}\\)$' THEN NULL ELSE legal_name END
              AS legal_name,
            CASE WHEN bill_footer ~ 'rehearsal [0-9a-f]{6}$' THEN NULL ELSE bill_footer END
              AS bill_footer,
            allow_pay_later, gst_enabled
       FROM billing_settings`,
  );
  await query(
    `UPDATE billing_settings
        SET legal_name = $1, bill_footer = $2, allow_pay_later = TRUE, gst_enabled = FALSE`,
    [`Gini Advanced Care Hospital (rehearsal ${tag})`, `Get well soon — rehearsal ${tag}`],
  );

  await ensureSeries(day);

  day.cghs = (
    await insert(
      "patient_schemes",
      { code: `ft_cghs_${tag}`, label: `CGHS ${tag}`, payer_name: `CGHS Wellness ${tag}` },
      "code",
    )
  ).code;
  const sub = async (key, label, extra = {}) =>
    (
      await insert(
        "patient_schemes",
        { code: `ft_${key}_${tag}`, label, parent_code: day.cghs, ...extra },
        "code",
      )
    ).code;
  day.paid = await sub("paid", "Paid", { requires_ref: true });
  day.referral = await sub("ref", "Referral", {
    requires_referral: true,
    requires_referral_doc: true,
  });
  day.pensioner = await sub("pens", "Pensioner");

  const rule = (scheme_code, name, values) =>
    insert("category_payment_rules", {
      scheme_code,
      name: `FT ${name} ${tag}`,
      remainder: "claim",
      ...values,
    });
  await rule(day.paid, "Paid half", { patient_pays: "percent", patient_value: 50 });
  await rule(day.referral, "Referral nothing", { patient_pays: "nothing" });
  await rule(day.pensioner, "Pensioner nothing", { patient_pays: "nothing" });

  day.group = (await insert("service_groups", { code: `FTG-${tag}`, name: `OPD ${tag}` })).id;
  day.subgroup = (
    await insert("service_subgroups", {
      group_id: day.group,
      code: `FTS-${tag}`,
      name: `OPD services ${tag}`,
    })
  ).id;

  const item = async (code, name, price, extra = {}) =>
    (
      await insert("service_items", {
        code: `FT-${code}-${tag}`,
        name: `${name} ${tag}`,
        subgroup_id: day.subgroup,
        base_price: price,
        kind: "procedure",
        ...extra,
      })
    ).id;

  const consult = (code, name, price, visitType, doctor) =>
    retryOnConsultation(tag, () =>
      item(code, name, price, {
        kind: "consultation",
        visit_type: visitType,
        doctor_id: doctor.id,
      }),
    );
  day.items = {};
  day.items.rahulNew = await consult(
    "RN",
    "Consultation Dr Rahul New",
    PRICES.rahulNew,
    "New",
    ROSTER.rahul,
  );
  day.items.rahulFollowUp = await consult(
    "RF",
    "Consultation Dr Rahul Follow Up",
    PRICES.rahulFollowUp,
    "Follow Up",
    ROSTER.rahul,
  );
  day.items.beantNew = await consult(
    "BN",
    "Consultation Dr Beant New",
    PRICES.beantNew,
    "New",
    ROSTER.beant,
  );
  day.items.beantFollowUp = await consult(
    "BF",
    "Consultation Dr Beant Follow Up",
    PRICES.beantFollowUp,
    "Follow Up",
    ROSTER.beant,
  );
  day.items.dressing = await item("DR", "Dressing", PRICES.dressing);

  const catalogue = async (name, price) =>
    (
      await insert("giniflow_test_catalog", {
        test_name: `${name} ${tag}`,
        price,
        category: "lab",
      })
    ).id;
  day.tests = {
    hba1c: `FT HbA1c ${tag}`,
    lipid: `FT Lipid ${tag}`,
    loose: `FT Uric acid ${tag}`,
  };
  const hba1cTest = await catalogue("FT HbA1c", PRICES.hba1c);
  const lipidTest = await catalogue("FT Lipid", PRICES.lipid);
  await catalogue("FT Uric acid", 200);
  day.items.hba1c = await item("HB", "HbA1c", PRICES.hba1c, {
    kind: "test",
    test_catalog_id: hba1cTest,
  });
  day.items.lipid = await item("LP", "Lipid profile", PRICES.lipid, {
    kind: "test",
    test_catalog_id: lipidTest,
  });

  day.code = `FT10${T}`;
  day.codeName = `FT Staff ten ${tag}`;
  await insert("discount_rules", {
    code: day.code,
    name: day.codeName,
    method: "code",
    kind: "percent",
    value: 10,
    applies_per: "line",
  });

  const patient = async (key, label, { doctor, visitType, scheme, age = 58, sex = "Male" }) => {
    const name = `FT ${label} ${tag}`;
    const fileNo = `FT${key}-${tag}`;
    const id = (
      await insert("patients", { name, file_no: fileNo, age, sex, scheme_code: scheme ?? null })
    ).id;
    const appointment = (
      await insert("appointments", {
        patient_id: id,
        patient_name: name,
        file_no: fileNo,
        appointment_date: day.date,
        visit_type: visitType,
        doctor_id: doctor.id,
        doctor_name: doctor.name,
      })
    ).id;
    const visit = (
      await insert("giniflow_visits", {
        patient_id: id,
        visit_date: day.date,
        appointment_id: appointment,
        assigned_doctor_id: doctor.id,
      })
    ).id;
    day.patients[key] = { id, name, fileNo, appointment, visit, doctor, visitType };
    return day.patients[key];
  };
  await patient("gen", "General", { doctor: ROSTER.rahul, visitType: "New Patient" });
  await patient("paid", "CGHS Paid", {
    doctor: ROSTER.beant,
    visitType: "Follow Up",
    scheme: day.cghs,
  });
  await patient("ref", "CGHS Referral", {
    doctor: ROSTER.rahul,
    visitType: "Follow Up",
    scheme: day.cghs,
  });
  await patient("pens", "Pensioner", {
    doctor: ROSTER.beant,
    visitType: "New Patient",
    scheme: day.cghs,
    age: 74,
  });
  await patient("later", "Pay Later", { doctor: ROSTER.rahul, visitType: "Follow Up" });
  await patient("cancel", "Cancel", { doctor: ROSTER.beant, visitType: "Follow Up" });
  return day;
}

const idsOf = async (text, params) => (await query(text, params)).rows.map((row) => row.id);

export async function sweepDay(tag) {
  const T = tag.toUpperCase();
  const schemes = `ft\\_%\\_${tag}`;
  const patients = await idsOf(`SELECT id FROM patients WHERE file_no ~ $1`, [`^FT[a-z]+-${tag}$`]);
  const visits = await idsOf(`SELECT id FROM giniflow_visits WHERE patient_id = ANY($1)`, [
    patients,
  ]);
  const items = await idsOf(
    `SELECT id FROM service_items WHERE code LIKE $1
        OR subgroup_id IN (SELECT id FROM service_subgroups WHERE code = 'FTS-' || $2)`,
    [`FT-%-${tag}`, tag],
  );
  const bills = await idsOf(
    `SELECT id FROM bills WHERE patient_id = ANY($1) OR visit_id = ANY($2) OR scheme_code LIKE $3`,
    [patients, visits, schemes],
  );
  const lines = await idsOf(
    `SELECT id FROM bill_lines WHERE bill_id = ANY($1) OR service_item_id = ANY($2)`,
    [bills, items],
  );
  const shifts = await idsOf(
    `SELECT DISTINCT shift_id AS id FROM payments WHERE bill_id = ANY($1) AND shift_id IS NOT NULL`,
    [bills],
  );
  await query(`DELETE FROM bill_line_discounts WHERE bill_line_id = ANY($1)`, [lines]);
  await query(`DELETE FROM bill_lines WHERE id = ANY($1) AND credited_line_id IS NOT NULL`, [
    lines,
  ]);
  await query(`DELETE FROM bill_lines WHERE id = ANY($1)`, [lines]);
  await query(`DELETE FROM payments WHERE bill_id = ANY($1)`, [bills]);
  await query(
    `DELETE FROM cash_shifts s WHERE s.id = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.shift_id = s.id)`,
    [shifts],
  );
  await query(
    `DELETE FROM billing_requests
      WHERE patient_id = ANY($1) OR visit_id = ANY($2) OR bill_id = ANY($3)
         OR created_item_id = ANY($4) OR service_item_id = ANY($4) OR reason LIKE $5`,
    [patients, visits, bills, items, `%${tag}`],
  );
  await query(`DELETE FROM bills WHERE id = ANY($1) AND original_bill_id IS NOT NULL`, [bills]);
  await query(`DELETE FROM bills WHERE id = ANY($1)`, [bills]);
  await query(`DELETE FROM giniflow_lab_orders WHERE visit_id = ANY($1)`, [visits]);
  await query(`DELETE FROM giniflow_visits WHERE id = ANY($1)`, [visits]);
  await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
  await query(`DELETE FROM documents WHERE patient_id = ANY($1)`, [patients]);
  await query(`DELETE FROM giniflow_patient_bills WHERE patient_id = ANY($1)`, [patients]).catch(
    () => {},
  );
  await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
  await query(`DELETE FROM discount_rules WHERE name LIKE $1 OR code = $2`, [
    `FT % ${tag}`,
    `FT10${T}`,
  ]);
  await query(
    `DELETE FROM category_payment_rules WHERE name LIKE $1 OR scheme_code LIKE $2
        OR service_item_id = ANY($3)`,
    [`FT % ${tag}`, schemes, items],
  );
  await query(`DELETE FROM category_item_rates WHERE service_item_id = ANY($1)`, [items]);
  await query(`DELETE FROM service_items WHERE id = ANY($1)`, [items]);
  await query(`DELETE FROM giniflow_test_catalog WHERE test_name LIKE $1`, [`FT % ${tag}`]);
  await query(`DELETE FROM service_subgroups WHERE code = 'FTS-' || $1`, [tag]);
  await query(`DELETE FROM service_groups WHERE code = 'FTG-' || $1`, [tag]);
  await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, [schemes]);
  await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, [schemes]);
}

async function dayTags() {
  const { rows } = await query(
    `SELECT substring(code FROM '^FTG-([0-9a-f]{6})$') AS tag FROM service_groups
      WHERE code LIKE 'FTG-%'
     UNION SELECT substring(file_no FROM '^FT[a-z]+-([0-9a-f]{6})$') FROM patients
      WHERE file_no LIKE 'FT%'
     UNION SELECT substring(code FROM '^ft_[a-z]+_([0-9a-f]{6})$') FROM patient_schemes
      WHERE code LIKE 'ft\\_%'`,
  );
  return [...new Set(rows.map((row) => row.tag).filter(Boolean))];
}

export async function sweepAbandonedDays() {
  const client = await getPool().connect();
  const abandoned = [];
  try {
    for (const tag of await dayTags()) if (!(await live(client, tag))) abandoned.push(tag);
  } finally {
    client.release();
  }
  for (const tag of abandoned) await sweepDay(tag);
}

async function releaseSeries(day) {
  const others = await one(
    `SELECT EXISTS (SELECT 1 FROM service_groups
                     WHERE code LIKE 'P4G-%' OR (code LIKE 'FTG-%' AND code <> 'FTG-' || $1)) AS busy`,
    [day.tag],
  );
  if (others.busy) return;
  await query(
    `DELETE FROM bill_series WHERE fy = $1
        AND ((series = 'MAIN' AND prefix ~ '^FT[0-9A-F]{6}/$')
          OR (series = 'RCPT' AND prefix ~ '^FR[0-9A-F]{6}/$'))`,
    [day.fy],
  );
}

export async function tearDownDay(day) {
  if (!day?.tag) return;
  try {
    if (day.settingsBefore) {
      await query(
        `UPDATE billing_settings
            SET legal_name = $1, bill_footer = $2, allow_pay_later = $3, gst_enabled = $4`,
        [
          day.settingsBefore.legal_name,
          day.settingsBefore.bill_footer,
          day.settingsBefore.allow_pay_later,
          day.settingsBefore.gst_enabled,
        ],
      );
    }
    await sweepDay(day.tag);
    await query(`DELETE FROM cash_shifts WHERE id = ANY($1)`, [day.shiftIds ?? []]).catch(() => {});
    await releaseSeries(day);
  } finally {
    await release(day.tag);
  }
}
