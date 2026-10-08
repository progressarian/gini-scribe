import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { COUNTER_BILL_STATE as STATE } from "../../../shared/billingVocab.js";
import { CHAIN, chainIndex } from "../../../shared/giniflowStatus.js";
import {
  ARRIVAL_SELECT,
  EXPECTED_STATUSES,
  FINISHED_STATUSES,
  NOT_COMING_STATUSES,
  shapeArrival,
} from "../giniflow/receptionStation.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "../giniflow/labOnlyVisits.js";
import { searchDayVisits } from "../giniflow/board.js";
import { IST_TODAY } from "../giniflow/statusEngine.js";
import { TEST_MATCHES_SQL } from "./testMatch.js";
import {
  ON_PATIENT_DAY_BILL_SQL,
  PAID_DRAFT_SQL,
  VISIT_LAB_CASE_TESTS_SQL,
} from "./labCaseLines.js";
import { REMOVED_BY_DESK_SQL } from "./visitLines.js";
import { HELD_AT_RECEPTION, RECEPTION_MONEY_SQL, SETTLED_AT_RECEPTION } from "./orderLinks.js";

const ONLINE_BOOKING = "(tele|online|video)";

const SEEN_BY_DOCTOR = CHAIN.slice(chainIndex("doctor_done"), chainIndex("dispensed") + 1);
const sqlList = (values) => values.map((value) => `'${value}'`).join(", ");
const SETTLED_ORDER = sqlList(["paid", "claim_approved", "insurance_claim"]);
const LEFT_WITHOUT_CONSULTATION = `(e.meta ->> 'source' IS NOT DISTINCT FROM 'counter_end_visit'
  OR e.meta ->> 'reason' IS NOT DISTINCT FROM 'lab_only_reports_complete')`;

export const COUNTER_GROUP = { TO_BILL: "toBill", BILLED: "billed", WAITING: "waiting" };

const DAY_TESTS = `ARRAY(SELECT dt.test_name
                           FROM giniflow_lab_order_tests dt
                           JOIN giniflow_lab_orders dlo ON dlo.id = dt.lab_order_id
                           JOIN giniflow_visits dv ON dv.id = dlo.visit_id
                          WHERE dv.visit_date = $1::date
                         UNION
                         SELECT btrim(dn.test_name)
                           FROM lab_cases dlc
                           CROSS JOIN LATERAL unnest(COALESCE(dlc.test_names, '{}'::text[]))
                             AS dn(test_name)
                          WHERE dlc.case_date = $1::date
                             OR dlc.appointment_id IN (SELECT appointment_id FROM giniflow_visits
                                                        WHERE visit_date = $1::date))`;

const COUNTER_SELECT = `
  WITH day_tests AS MATERIALIZED (${TEST_MATCHES_SQL(DAY_TESTS)})
  SELECT a.*,
         ${labOnlyPredicate("gv", "$2")} AS samples_only,
         COALESCE(a.booking_type ~* '${ONLINE_BOOKING}', FALSE) AS online,
         bs.drafts, bs.paid_drafts, bs.finals, bs.pending_claims, bs.cleared_claims, bs.due,
         bs.draft_due, bs.open_drafts, bs.pay_back, bs.refunds_pending, bs.paid_back,
         cs.seen, cs.consultation_billed,
         EXISTS (SELECT 1 FROM consultant_changes cc
                  WHERE cc.visit_id = a.id AND cc.status = 'pending') AS consultant_changed,
         ts.tests_owed, ts.not_priced, ts.settled_orders, lcs.case_tests_owed
    FROM (${ARRIVAL_SELECT}) a
    JOIN giniflow_visits gv ON gv.id = a.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE b.status = 'draft' AND NOT ${PAID_DRAFT_SQL("b")})::int
               AS drafts,
             COUNT(*) FILTER (WHERE ${PAID_DRAFT_SQL("b")})::int AS paid_drafts,
             COUNT(*) FILTER (WHERE b.status = 'final')::int AS finals,
             COUNT(*) FILTER (WHERE b.status = 'final' AND b.claim_status = 'pending')::int
               AS pending_claims,
             COUNT(*) FILTER (WHERE b.status = 'final' AND b.claim_status = 'cleared')::int
               AS cleared_claims,
             COALESCE(SUM(GREATEST(GREATEST(b.patient_payable - m.credited, 0)
                                   - (b.paid_amount - m.refunded), 0))
                        FILTER (WHERE b.status = 'final'), 0) AS due,
             COALESCE(SUM(LEAST(GREATEST((b.paid_amount - m.refunded)
                                         - GREATEST(b.patient_payable - m.credited, 0), 0),
                                m.credited - m.refunded))
                        FILTER (WHERE b.status = 'final'), 0) AS pay_back,
             COALESCE(SUM(m.refunded) FILTER (WHERE b.status = 'final'), 0) AS paid_back,
             COUNT(*) FILTER (WHERE b.status = 'final' AND EXISTS (
               SELECT 1 FROM billing_requests rr
                WHERE rr.bill_id = b.id AND rr.kind = 'refund' AND rr.status = 'pending'))::int
               AS refunds_pending,
             COALESCE(SUM(GREATEST(b.patient_payable - b.paid_amount, 0))
                        FILTER (WHERE b.status = 'draft'), 0) AS draft_due,
             COUNT(*) FILTER (WHERE b.status = 'draft' AND NOT ${PAID_DRAFT_SQL("b")} AND EXISTS (
               SELECT 1 FROM bill_lines dl WHERE dl.bill_id = b.id AND dl.is_live))::int
               AS open_drafts
        FROM bills b
        CROSS JOIN LATERAL (
          SELECT COALESCE((SELECT SUM(c.patient_payable) FROM bills c
                            WHERE c.original_bill_id = b.id), 0) AS credited,
                 COALESCE((SELECT SUM(x.amount) FROM payments x JOIN bills c ON c.id = x.bill_id
                            WHERE c.original_bill_id = b.id), 0) AS refunded
        ) m
       WHERE b.visit_id = a.id AND b.bill_type = 'invoice'
         AND (b.status <> 'draft' OR b.saved_at IS NOT NULL)
    ) bs ON TRUE
    LEFT JOIN LATERAL (
      SELECT (a.current_status = ANY(ARRAY[${sqlList(SEEN_BY_DOCTOR)}])
              OR EXISTS (SELECT 1 FROM giniflow_visit_events e
                          WHERE e.visit_id = a.id
                            AND (e.status = ANY(ARRAY[${sqlList(SEEN_BY_DOCTOR)}])
                                 OR (e.status = 'exited' AND NOT ${LEFT_WITHOUT_CONSULTATION}))))
               AS seen,
             EXISTS (SELECT 1 FROM bill_lines l
                       JOIN bills b ON b.id = l.bill_id
                       JOIN service_items si ON si.id = l.service_item_id
                      WHERE l.visit_id = a.id AND l.is_live AND si.kind = 'consultation'
                        AND b.bill_type = 'invoice'
                        AND (b.status = 'final' OR ${PAID_DRAFT_SQL("b")}))
               AS consultation_billed
    ) cs ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(t.id) FILTER (WHERE NOT o.settled AND NOT t.on_final)::int AS tests_owed,
             COUNT(t.id) FILTER (WHERE NOT o.settled AND NOT t.on_final
                                   AND NOT t.priced)::int AS not_priced,
             COUNT(DISTINCT o.id) FILTER (WHERE o.settled)::int AS settled_orders
        FROM (SELECT o.id,
                     (o.payment_status IN (${SETTLED_ORDER}) AND o.amount_total > 0)
                     OR (${SETTLED_AT_RECEPTION} AND ${HELD_AT_RECEPTION("rm")}) AS settled
                FROM giniflow_lab_orders o
                CROSS JOIN LATERAL ${RECEPTION_MONEY_SQL("o")} rm
               WHERE o.visit_id = a.id) o
        JOIN LATERAL (
          SELECT ot.id,
                 EXISTS (SELECT 1 FROM service_items si
                          WHERE si.test_catalog_id = dm.catalog_id AND si.is_active) AS priced,
                 EXISTS (SELECT 1 FROM bill_lines bl
                           JOIN bills fb ON fb.id = bl.bill_id
                                AND (fb.status = 'final' OR ${PAID_DRAFT_SQL("fb")})
                           JOIN service_items si ON si.id = bl.service_item_id
                          WHERE bl.lab_order_id = o.id AND bl.is_live
                            AND si.test_catalog_id = dm.catalog_id) AS on_final
            FROM giniflow_lab_order_tests ot
            LEFT JOIN day_tests dm ON dm.test_name = ot.test_name
           WHERE ot.lab_order_id = o.id
        ) t ON TRUE
    ) ts ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT cm.catalog_id)::int AS case_tests_owed
        FROM (SELECT gv.id, gv.patient_id, gv.visit_date, gv.appointment_id, cp.file_no
                FROM patients cp WHERE cp.id = gv.patient_id) cv
        CROSS JOIN LATERAL (${VISIT_LAB_CASE_TESTS_SQL("cv")}) ct
        JOIN day_tests cm ON cm.test_name = ct.test_name
        JOIN LATERAL (SELECT ci.id FROM service_items ci
                       WHERE ci.test_catalog_id = cm.catalog_id AND ci.is_active
                       ORDER BY ci.id LIMIT 1) ci ON TRUE
       WHERE NOT ${ON_PATIENT_DAY_BILL_SQL("cv", "cm.catalog_id", ["final"], { paidDrafts: true })}
         AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders co
                           JOIN giniflow_lab_order_tests cot ON cot.lab_order_id = co.id
                           JOIN day_tests com ON com.test_name = cot.test_name
                          WHERE co.visit_id = cv.id AND com.catalog_id = cm.catalog_id)
         AND NOT ${REMOVED_BY_DESK_SQL("cv.id", "ci.id", { countDeletedDrafts: false })}
    ) lcs ON TRUE`;

function billState(r) {
  const due = paise(r.due);
  if (due > 0) return { state: STATE.DUE, due };
  if (r.drafts > 0) return { state: STATE.DRAFT, due: 0 };
  if (r.pending_claims > 0) return { state: STATE.CLAIM_PENDING, due: 0 };
  if (r.cleared_claims > 0) return { state: STATE.CLAIM_CLEARED, due: 0 };
  if (r.finals > 0 || r.paid_drafts > 0) return { state: STATE.PAID, due: 0 };
  return { state: STATE.NONE, due: 0 };
}

function billHints(r) {
  return {
    consultation: Boolean(r.seen) && !r.samples_only && !r.consultation_billed,
    tests: (r.tests_owed || 0) + (r.case_tests_owed || 0),
    notPriced: r.not_priced || 0,
    due: paise(r.due) + paise(r.draft_due),
    consultantChanged: Boolean(r.consultant_changed),
  };
}

function groupOf(r, hints, status) {
  if (FINISHED_STATUSES.includes(status)) return COUNTER_GROUP.BILLED;
  if (
    hints.consultation ||
    hints.consultantChanged ||
    hints.tests > 0 ||
    hints.due > 0 ||
    r.open_drafts > 0
  ) {
    return COUNTER_GROUP.TO_BILL;
  }
  if (r.finals > 0 || r.paid_drafts > 0 || r.settled_orders > 0) return COUNTER_GROUP.BILLED;
  return COUNTER_GROUP.WAITING;
}

const OPEN_BILL_STATES = [STATE.DUE, STATE.DRAFT, STATE.CLAIM_PENDING];

const notArrived = (row) => EXPECTED_STATUSES.includes(row.status);
const notComing = (row) => NOT_COMING_STATUSES.includes(row.status);
const leftToday = (row) => FINISHED_STATUSES.includes(row.status);

const byArrival = (a, b) =>
  (a.checkedInAt || "").localeCompare(b.checkedInAt || "") ||
  (a.slot || "").localeCompare(b.slot || "");

const arrivedFirst = (a, b) => Number(!a.checkedInAt) - Number(!b.checkedInAt) || byArrival(a, b);

async function istToday(db) {
  const { rows } = await db.query(`SELECT ${IST_TODAY}::text AS d`);
  return rows[0].d;
}

export async function counterPatients(visitDate, q = "", now = new Date(), db = pool) {
  const date = visitDate || (await istToday(db));
  const { rows } = await db.query(COUNTER_SELECT, [date, LAB_ONLY_DOCTOR, false]);

  let visible = rows;
  const query = String(q || "").trim();
  if (query.length >= 2) {
    const hits = new Set((await searchDayVisits(date, query, db)).map((r) => r.visitId));
    visible = rows.filter((r) => hits.has(r.id));
  }

  const shaped = visible.map((r) => {
    const hints = billHints(r);
    const arrival = shapeArrival(r, now);
    return {
      ...arrival,
      online: Boolean(r.online),
      samplesOnly: Boolean(r.samples_only),
      bill: billState(r),
      hints,
      payBack: paise(r.pay_back),
      refundPending: r.refunds_pending > 0,
      refunded: paise(r.paid_back),
      group: groupOf(r, hints, arrival.status),
    };
  });

  const patients = shaped.filter(
    (row) => !notComing(row) || OPEN_BILL_STATES.includes(row.bill.state),
  );
  const listed = shaped
    .filter((row) => !notComing(row) || row.group === COUNTER_GROUP.TO_BILL)
    .sort(arrivedFirst);
  const inGroup = (group) => listed.filter((row) => row.group === group);

  return {
    date,
    toBill: inGroup(COUNTER_GROUP.TO_BILL),
    billed: inGroup(COUNTER_GROUP.BILLED),
    waiting: inGroup(COUNTER_GROUP.WAITING),
    onFloor: patients
      .filter((row) => !notArrived(row) && !notComing(row) && !leftToday(row))
      .sort(byArrival),
    left: [
      ...patients.filter(leftToday).sort(byArrival),
      ...patients.filter(notComing).sort(byArrival),
    ],
    notArrived: patients.filter(notArrived),
    query,
  };
}
