import pool from "../../config/db.js";

// Reproduces the floor in docs/gini-flow-manager.html: 18 booked, 14 in the
// building, 8 done, a hot "Waiting — doctor" column, 2 blocked, 3 on the lab track.
//
// Gini Flow has no check-in of its own yet and deliberately does not read the
// older flow_* module, so until the station screens land this seeder IS the
// board's data. Events are written with explicit backdated occurred_at values so
// every timer, average and bottleneck the board computes is real arithmetic over
// a real log rather than a mocked number.

const MINUTE = 60_000;

// [status, minutes before now that it was entered]
const JOURNEYS = [
  {
    key: "blocked",
    category: "no_reports",
    blocked: "Blocked — reports not uploaded",
    steps: [
      ["checked_in", 34],
      ["blocked_reports", 33],
    ],
  },
  { key: "arrived", category: "worse_in_range", steps: [["checked_in", 4]] },
  {
    key: "at_vitals",
    category: "in_control",
    steps: [
      ["checked_in", 18],
      ["vitals_pending", 15],
      ["with_vitals", 3],
    ],
  },
  {
    key: "with_sd_a",
    category: "worse_in_range",
    sd: true,
    steps: [
      ["checked_in", 33],
      ["vitals_pending", 29],
      ["with_vitals", 25],
      ["vitals_done", 22],
      ["sd_pending", 21],
      ["with_sd", 9],
    ],
  },
  {
    key: "with_sd_b",
    category: "worse_in_range",
    sd: true,
    steps: [
      ["checked_in", 41],
      ["vitals_pending", 37],
      ["with_vitals", 33],
      ["vitals_done", 30],
      ["sd_pending", 28],
      ["with_sd", 13],
    ],
  },
  {
    key: "wait_doc_long",
    category: "worse_in_range",
    sd: true,
    results: "ready",
    steps: [
      ["checked_in", 78],
      ["vitals_pending", 71],
      ["with_vitals", 67],
      ["vitals_done", 63],
      ["sd_pending", 59],
      ["with_sd", 47],
      ["ready_for_doctor", 41],
    ],
  },
  {
    key: "wait_doc_green",
    category: "in_control",
    sd: true,
    results: "ready",
    steps: [
      ["checked_in", 52],
      ["vitals_pending", 47],
      ["with_vitals", 43],
      ["vitals_done", 40],
      ["sd_pending", 36],
      ["with_sd", 24],
      ["ready_for_doctor", 14],
    ],
  },
  {
    key: "wait_doc_red",
    category: "worse_out_of_range",
    sd: true,
    steps: [
      ["checked_in", 47],
      ["vitals_pending", 43],
      ["with_vitals", 39],
      ["vitals_done", 36],
      ["sd_pending", 33],
      ["with_sd", 21],
      ["ready_for_doctor", 12],
    ],
  },
  {
    key: "wait_doc_ok",
    category: "worse_in_range",
    sd: true,
    results: "ready",
    steps: [
      ["checked_in", 39],
      ["vitals_pending", 35],
      ["with_vitals", 31],
      ["vitals_done", 28],
      ["sd_pending", 25],
      ["with_sd", 13],
      ["ready_for_doctor", 6],
    ],
  },
  {
    key: "with_doc_a",
    category: "worse_in_range",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 64],
      ["vitals_pending", 59],
      ["with_vitals", 55],
      ["vitals_done", 52],
      ["sd_pending", 49],
      ["with_sd", 37],
      ["ready_for_doctor", 27],
      ["with_doctor", 18],
    ],
  },
  {
    key: "with_doc_b",
    category: "worse_out_of_range",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 51],
      ["vitals_pending", 46],
      ["with_vitals", 42],
      ["vitals_done", 39],
      ["sd_pending", 36],
      ["with_sd", 24],
      ["ready_for_doctor", 16],
      ["with_doctor", 8],
    ],
  },
  {
    key: "pharmacy_a",
    category: "in_control",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 58],
      ["vitals_pending", 53],
      ["with_vitals", 49],
      ["vitals_done", 46],
      ["sd_pending", 43],
      ["with_sd", 31],
      ["ready_for_doctor", 22],
      ["with_doctor", 14],
      ["doctor_done", 5],
      ["pharmacy_pending", 4],
    ],
  },
  {
    key: "pharmacy_b",
    category: "worse_in_range",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 83],
      ["vitals_pending", 78],
      ["with_vitals", 74],
      ["vitals_done", 71],
      ["sd_pending", 68],
      ["with_sd", 55],
      ["ready_for_doctor", 44],
      ["with_doctor", 30],
      ["doctor_done", 11],
      ["pharmacy_pending", 9],
    ],
  },
  {
    key: "blocked_2",
    category: "no_reports",
    blocked: "Blocked — awaiting outside reports",
    steps: [
      ["checked_in", 21],
      ["blocked_reports", 20],
    ],
  },
  // Blocked, then unblocked — the recovery path the coordinator sees most often,
  // and the one that exercises resume_status.
  {
    key: "recovered",
    category: "getting_better",
    steps: [
      ["checked_in", 29],
      ["blocked_reports", 27],
      ["vitals_pending", 9],
      ["with_vitals", 4],
    ],
  },
];

const doneJourney = (offsetMin, totalMin) => ({
  key: `done_${offsetMin}`,
  category: "in_control",
  sd: true,
  doctor: true,
  results: "ready",
  steps: [
    ["checked_in", offsetMin],
    ["vitals_pending", offsetMin - 6],
    ["with_vitals", offsetMin - 9],
    ["vitals_done", offsetMin - 12],
    ["sd_pending", offsetMin - 14],
    ["with_sd", offsetMin - 22],
    ["ready_for_doctor", offsetMin - 31],
    ["with_doctor", offsetMin - 39],
    ["doctor_done", offsetMin - 47],
    ["pharmacy_pending", offsetMin - 52],
    ["dispensed", offsetMin - totalMin + 2],
    ["exited", offsetMin - totalMin],
  ],
});

// `events` are [track, status, minutesAgo] — the log the lab and reception
// screens will write for real. Without them the lab_total and reception_payment
// footer budgets have nothing to measure (GF-07, GF-12).
const LAB_ORDERS = [
  {
    journey: "pharmacy_a",
    sampleStatus: "uploaded",
    paymentStatus: "paid",
    minutes: 46,
    uploadedMinutesAgo: 8,
    events: [
      ["payment", "pending", 46],
      ["payment", "paid", 38],
      ["sample", "sample_collected", 36],
      ["sample", "processing", 30],
      ["sample", "results_ready", 12],
      ["sample", "uploaded", 8],
    ],
    tests: [
      ["HbA1c", 600],
      ["Lipid profile", 800],
    ],
  },
  {
    journey: "with_doc_a",
    sampleStatus: "payment_pending",
    paymentStatus: "pending",
    minutes: 12,
    tests: [
      ["Lipid profile", 800],
      ["HbA1c", 600],
      ["CBC", 400],
      ["KFT", 700],
      ["LFT", 700],
      ["TSH", 500],
    ],
  },
  {
    journey: "wait_doc_long",
    sampleStatus: "processing",
    paymentStatus: "paid",
    minutes: 24,
    tests: [
      ["HbA1c", 600],
      ["Lipid profile", 800],
      ["Urine R/M", 300],
      ["Creatinine", 350],
      ["Vitamin D", 1200],
    ],
  },
  {
    journey: "with_sd_a",
    sampleStatus: "results_ready",
    paymentStatus: "paid",
    minutes: 18,
    tests: [
      ["CBC", 400],
      ["HbA1c", 600],
      ["KFT", 700],
      ["TSH", 500],
    ],
  },
];

const ACTOR_FOR = {
  checked_in: "reception",
  vitals_pending: "reception",
  blocked_reports: "reception",
  with_vitals: "vitals",
  vitals_done: "vitals",
  sd_pending: "vitals",
  with_sd: "mo_sd",
  ready_for_doctor: "mo_sd",
  with_doctor: "doctor",
  doctor_done: "doctor",
  pharmacy_pending: "doctor",
  dispensed: "pharmacy",
  exited: "pharmacy",
};

const DEMO_MARKER = "giniflow-demo";

// GF-03: the seeder used to pick real patients (`SELECT id FROM patients ORDER BY
// id LIMIT n`) and write fabricated categories, vitals and blocked reasons against
// them. Those are clinical attributes about identifiable people, in a DPDP-covered
// production database. It creates its own patients instead, marked unmistakably in
// both the name and the file number, and deletes them again on clean.
const DEMO_FILE_PREFIX = "ZZDEMO_";

const DEMO_NAMES = [
  "Demo Nishant Puri",
  "Demo Harpreet Kaur",
  "Demo Rakesh Sharma",
  "Demo Anil Dhamija",
  "Demo Sunita Devi",
  "Demo Isha Gambhir",
  "Demo Deepak Khanna",
  "Demo Promila Puri",
  "Demo Mohan Lal",
  "Demo Sandeep Kumar",
  "Demo Gurmail Singh",
  "Demo Kamla Devi",
  "Demo Baljit Singh",
  "Demo Ravinder Grewal",
  "Demo Jasbir Kaur",
  "Demo Satpal Singh",
  "Demo Neelam Rani",
  "Demo Ashok Verma",
  "Demo Manjit Kaur",
  "Demo Rajesh Bansal",
  "Demo Kiran Bala",
  "Demo Surinder Pal",
];

async function ensureDemoPatients(client, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const fileNo = `${DEMO_FILE_PREFIX}${String(i + 1).padStart(3, "0")}`;
    const { rows } = await client.query(
      `INSERT INTO patients (name, file_no, age, sex, phone)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [DEMO_NAMES[i % DEMO_NAMES.length], fileNo, 40 + ((i * 3) % 35), i % 2 ? "Female" : "Male"],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function pickDoctors(client) {
  const { rows } = await client.query(
    `SELECT id FROM doctors WHERE COALESCE(is_active, TRUE) ORDER BY is_chief DESC NULLS LAST, id LIMIT 2`,
  );
  return { chief: rows[0]?.id ?? null, sd: rows[1]?.id ?? rows[0]?.id ?? null };
}

// GF-P0: a destructive/fabricating routine needs more than a role check on the
// live host. Both entry points refuse unless GINIFLOW_ALLOW_DEMO is set.
export const demoAllowed = () => process.env.GINIFLOW_ALLOW_DEMO === "1";

const assertDemoAllowed = () => {
  if (!demoAllowed()) {
    throw Object.assign(
      new Error("Demo seeding is disabled. Set GINIFLOW_ALLOW_DEMO=1 to enable it."),
      { status: 403 },
    );
  }
};

// `date` exists so the smoke suite can seed a day of its own. Once the HealthRay
// sync runs, today belongs to real patients — a test that seeds into it collides
// with them and asserts against a mixture of both.
export async function seedDemoDay({ db = pool, date = null } = {}) {
  assertDemoAllowed();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const journeys = [
      ...JOURNEYS,
      doneJourney(140, 64),
      doneJourney(133, 69),
      doneJourney(126, 71),
      doneJourney(119, 66),
      doneJourney(112, 74),
      doneJourney(105, 68),
      doneJourney(98, 77),
      doneJourney(91, 70),
    ];

    const patientIds = await ensureDemoPatients(client, journeys.length);
    const doctors = await pickDoctors(client);
    const now = Date.now();
    const at = (minsAgo) => new Date(now - minsAgo * MINUTE).toISOString();

    // Bulk inserts, not a loop of round trips: the seeder runs against a remote
    // pooler and ~200 sequential statements inside one transaction is long
    // enough for the connection to be dropped mid-way.
    const visitRows = journeys.map((journey, i) => ({
      journey,
      patientId: patientIds[i],
      finalStatus: journey.steps[journey.steps.length - 1][0],
      appointmentTime: `${String(8 + (i % 4)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`,
    }));

    const inserted = await client.query(
      `INSERT INTO giniflow_visits
         (patient_id, visit_date, current_status, results_status, category, blocked_reason,
          assigned_sd_id, assigned_doctor_id, appointment_time, is_demo)
       SELECT t.patient_id, COALESCE($9::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date), t.current_status,
              t.results_status, t.category, t.blocked_reason, t.sd_id, t.doctor_id, t.appt_time, TRUE
         FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
                     $6::int[], $7::int[], $8::time[])
           AS t(patient_id, current_status, results_status, category, blocked_reason,
                sd_id, doctor_id, appt_time)
       ON CONFLICT (patient_id, visit_date) DO NOTHING
       RETURNING id, patient_id`,
      [
        visitRows.map((v) => v.patientId),
        visitRows.map((v) => v.finalStatus),
        visitRows.map((v) => v.journey.results || "none"),
        visitRows.map((v) => v.journey.category),
        visitRows.map((v) => v.journey.blocked || null),
        visitRows.map((v) => (v.journey.sd ? doctors.sd : null)),
        visitRows.map((v) => (v.journey.doctor ? doctors.chief : null)),
        visitRows.map((v) => v.appointmentTime),
        date,
      ],
    );

    const idByPatient = new Map(inserted.rows.map((r) => [r.patient_id, r.id]));
    const byKey = {};
    const events = [];
    for (const row of visitRows) {
      const visitId = idByPatient.get(row.patientId);
      if (!visitId) continue;
      byKey[row.journey.key] = visitId;
      for (const [status, minsAgo] of row.journey.steps) {
        events.push({
          visitId,
          status,
          actorRole: ACTOR_FOR[status] || "system",
          occurredAt: at(minsAgo),
          meta:
            status === "with_vitals"
              ? { vitals: { bp: "143/90", weight: 116.8 } }
              : { [DEMO_MARKER]: true },
        });
      }
    }

    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::jsonb[])`,
      [
        events.map((e) => e.visitId),
        events.map((e) => e.status),
        events.map((e) => e.actorRole),
        events.map((e) => e.occurredAt),
        events.map((e) => JSON.stringify(e.meta)),
      ],
    );

    let labOrders = 0;
    for (const order of LAB_ORDERS) {
      const visitId = byKey[order.journey];
      if (!visitId) continue;
      const created = await client.query(
        `INSERT INTO giniflow_lab_orders
           (visit_id, ordered_by, urgency, payment_status, amount_total, sample_status,
          created_at, updated_at, uploaded_at)
         VALUES ($1, $2, 'today', $3, $4, $5, $6, $6, $7) RETURNING id`,
        [
          visitId,
          doctors.chief,
          order.paymentStatus,
          order.tests.reduce((sum, [, price]) => sum + price, 0),
          order.sampleStatus,
          at(order.minutes),
          order.uploadedMinutesAgo ? at(order.uploadedMinutesAgo) : null,
        ],
      );
      if (order.events?.length) {
        await client.query(
          `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, occurred_at)
           SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
          [
            created.rows[0].id,
            order.events.map((e) => e[0]),
            order.events.map((e) => e[1]),
            order.events.map((e) => (e[0] === "payment" ? "reception" : "lab")),
            order.events.map((e) => at(e[2])),
          ],
        );
      }
      await client.query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
         SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])`,
        [created.rows[0].id, order.tests.map((t) => t[0]), order.tests.map((t) => t[1])],
      );
      labOrders++;
    }

    await client.query("COMMIT");
    const skipped = visitRows
      .filter((r) => !idByPatient.get(r.patientId))
      .map((r) => r.journey.key);
    return {
      visits: Object.keys(byKey).length,
      events: events.length,
      labOrders,
      skipped,
      ...(skipped.length
        ? {
            note: `${skipped.length} journey(s) skipped — a visit already exists for that patient today`,
          }
        : {}),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Removes only rows this seeder created. Never date-wide: once check-in ships,
// a date-wide delete here would wipe the live floor (GF-01).
export async function cleanDemoDay(db = pool) {
  assertDemoAllowed();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(`DELETE FROM giniflow_visits WHERE is_demo`);
    const patients = await client.query(`DELETE FROM patients WHERE file_no LIKE $1 || '%'`, [
      DEMO_FILE_PREFIX,
    ]);
    await client.query("COMMIT");
    return { deleted: rowCount, demoPatientsRemoved: patients.rowCount };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
