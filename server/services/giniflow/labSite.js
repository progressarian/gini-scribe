import pool from "../../config/db.js";
import { HOME_COLLECTION_SQL } from "./homeCollection.js";
import { IST_TODAY } from "./statusEngine.js";
import { publish } from "./eventHub.js";
import { publishEvents } from "./realtimeBus.js";
import { logAppointmentEvent } from "../appointmentHistory.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";
import { repriceOpenLabOrders } from "./homeOrderPrices.js";

export const LAB_SITES = ["home", "ghm"];
const CLOSED_STATUSES = ["no_show", "cancelled"];

const fail = (status, message) => Object.assign(new Error(message), { status });

const SAMPLE_TAKEN_SQL = (v) => `(
  EXISTS (
    SELECT 1 FROM giniflow_lab_order_events le
      JOIN giniflow_lab_orders lo ON lo.id = le.lab_order_id
     WHERE lo.visit_id = ${v}.id AND le.track = 'sample' AND le.status = 'sample_collected'
  )
  OR EXISTS (
    SELECT 1 FROM giniflow_lab_case_actions la
      JOIN lab_cases lk ON lk.case_no = la.case_no
     WHERE la.action = 'sample_taken'
       AND lk.case_date = ${v}.visit_date AND lk.patient_id = ${v}.patient_id
  )
  OR (
    SELECT r.sample = 'collected' FROM giniflow_home_samples r
     WHERE r.visit_id = ${v}.id
     ORDER BY r.entered_at DESC, r.id DESC
     LIMIT 1
  ) IS TRUE
)`;

const HAS_LAB_TEST_SQL = (v) => `(
  EXISTS (
    SELECT 1 FROM giniflow_lab_orders lo
     WHERE lo.visit_id = ${v}.id AND lo.kind = 'lab' AND lo.urgency = 'today'
       AND EXISTS (SELECT 1 FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = lo.id)
  )
  OR EXISTS (
    SELECT 1 FROM lab_cases lc
     WHERE lc.case_date = ${v}.visit_date AND lc.patient_id = ${v}.patient_id
       AND cardinality(COALESCE(lc.test_names, ARRAY[]::text[])) > 0
       AND ${LIVE_LAB_CASE_SQL("lc")}
  )
  OR EXISTS (
    SELECT 1 FROM bill_lines bl
      JOIN bills bb ON bb.id = bl.bill_id
      JOIN service_items bs ON bs.id = bl.service_item_id
      JOIN giniflow_test_catalog btc ON btc.id = bs.test_catalog_id
     WHERE bl.visit_id = ${v}.id AND bl.is_live AND bb.status <> 'cancelled'
       AND bs.kind = 'test' AND btc.category = 'lab'
  )
)`;

async function siteRow(db, visitId, lock = false) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            v.appointment_id, v.merged_into_visit_id, v.lab_site, v.lab_site_at,
            COALESCE(sd.short_name, sd.name) AS lab_site_by_name,
            p.name, p.file_no,
            (v.visit_date = ${IST_TODAY}) AS today,
            ${HOME_COLLECTION_SQL("v")} AS home,
            ${SAMPLE_TAKEN_SQL("v")} AS locked,
            ${HAS_LAB_TEST_SQL("v")} AS has_lab_test,
            ap.id AS booking_id, ap.home_collection AS booking_home
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors sd ON sd.id = v.lab_site_by
       LEFT JOIN LATERAL (
         SELECT a.id, a.home_collection FROM appointments a
          WHERE a.patient_id = v.patient_id AND a.appointment_date = v.visit_date
            AND COALESCE(a.status, '') <> 'cancelled'
          ORDER BY (a.id = v.appointment_id) DESC, a.id
          LIMIT 1
       ) ap ON TRUE
      WHERE v.id = $1
      ${lock ? "FOR UPDATE OF v" : ""}`,
    [visitId],
  );
  return rows[0] ?? null;
}

const notArrived = (r) => r.current_status === "booked";

const shape = (r) => ({
  visitId: r.id,
  name: r.name,
  fileNo: r.file_no,
  site: r.home ? "home" : "ghm",
  setOnFloor: Boolean(r.lab_site),
  setBy: r.lab_site_by_name || null,
  setAt: r.lab_site_at ? new Date(r.lab_site_at).toISOString() : null,
  locked: Boolean(r.locked),
  applies: Boolean(r.has_lab_test) || Boolean(r.home),
  notArrived: notArrived(r),
  editable:
    Boolean(r.today) &&
    (Boolean(r.has_lab_test) || Boolean(r.home)) &&
    !r.locked &&
    !CLOSED_STATUSES.includes(r.current_status),
  today: Boolean(r.today),
});

export async function labSiteOf(visitId, db = pool) {
  const row = await siteRow(db, visitId);
  if (!row) throw fail(404, "Visit not found");
  return shape(row);
}

const SITE_WORD = { home: "Home collection", ghm: "At GHM" };

export async function setLabSite(
  visitId,
  site,
  { actorId = null, actorName = null, atCheckIn = false } = {},
  db = pool,
) {
  if (!LAB_SITES.includes(site)) throw fail(400, "Choose 🏥 At GHM or 🏠 Home collection");
  const client = await db.connect();
  let row;
  try {
    await client.query("BEGIN");
    row = await siteRow(client, visitId, true);
    if (!row) throw fail(404, "Visit not found");
    if (row.merged_into_visit_id) throw fail(409, "This visit was merged into another one");
    if (!row.today) throw fail(400, "The lab sample can only be set for today's visit");
    if (CLOSED_STATUSES.includes(row.current_status)) {
      throw fail(409, "This visit is marked no-show or cancelled — undo that first");
    }
    if (row.locked) throw fail(409, "The sample is already collected — the category can't change");
    if (!row.has_lab_test && !row.home && !(atCheckIn && notArrived(row))) {
      throw fail(400, "This patient has no lab test today");
    }
    if ((row.home ? "home" : "ghm") === site && row.lab_site === site) {
      await client.query("COMMIT");
      return { ...shape(row), unchanged: true };
    }

    await client.query(
      `UPDATE giniflow_visits SET lab_site = $2, lab_site_by = $3, lab_site_at = NOW()
        WHERE id = $1`,
      [row.id, site, actorId],
    );
    const wantHome = site === "home";
    if (row.booking_id && Boolean(row.booking_home) !== wantHome) {
      await client.query(`UPDATE appointments SET home_collection = $2 WHERE id = $1`, [
        row.booking_id,
        wantHome,
      ]);
      await logAppointmentEvent(client, {
        appointmentId: row.booking_id,
        field: "home_collection",
        label: "Home Collection",
        oldValue: row.booking_home ? "Yes" : "No",
        newValue: wantHome ? "Yes" : "No",
        actor: { id: actorId, name: actorName },
      });
    }
    await repriceOpenLabOrders(client, row.id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const event = { kind: "visit", visitId: row.id, status: "lab_site", date: row.visit_date };
  publish(event);
  publishEvents([event]);
  return { ...(await labSiteOf(row.id, db)), word: SITE_WORD[site] };
}

export async function followBookingTag(appointment, db = pool) {
  if (!appointment?.patient_id || !appointment?.appointment_date) return;
  await db.query(
    `UPDATE giniflow_visits SET lab_site = NULL, lab_site_by = NULL, lab_site_at = NULL
      WHERE patient_id = $1 AND visit_date = $2::date AND lab_site IS NOT NULL`,
    [appointment.patient_id, appointment.appointment_date],
  );
  const { rows } = await db.query(
    `SELECT id FROM giniflow_visits
      WHERE patient_id = $1 AND visit_date = $2::date AND merged_into_visit_id IS NULL`,
    [appointment.patient_id, appointment.appointment_date],
  );
  for (const { id } of rows) {
    await repriceOpenLabOrders(db, id).catch((e) =>
      console.warn("[lab site] home-collection reprice failed:", e.message),
    );
  }
}
