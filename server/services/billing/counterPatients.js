import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { COUNTER_BILL_STATE as STATE } from "../../../shared/billingVocab.js";
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

const ONLINE_BOOKING = "(tele|online|video)";

const COUNTER_SELECT = `
  SELECT a.*,
         ${labOnlyPredicate("gv", "$2")} AS samples_only,
         COALESCE(a.booking_type ~* '${ONLINE_BOOKING}', FALSE) AS online,
         bs.drafts, bs.finals, bs.pending_claims, bs.cleared_claims, bs.due
    FROM (${ARRIVAL_SELECT}) a
    JOIN giniflow_visits gv ON gv.id = a.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE b.status = 'draft')::int AS drafts,
             COUNT(*) FILTER (WHERE b.status = 'final')::int AS finals,
             COUNT(*) FILTER (WHERE b.status = 'final' AND b.claim_status = 'pending')::int
               AS pending_claims,
             COUNT(*) FILTER (WHERE b.status = 'final' AND b.claim_status = 'cleared')::int
               AS cleared_claims,
             COALESCE(SUM(GREATEST(GREATEST(b.patient_payable - m.credited, 0)
                                   - (b.paid_amount - m.refunded), 0))
                        FILTER (WHERE b.status = 'final'), 0) AS due
        FROM bills b
        CROSS JOIN LATERAL (
          SELECT COALESCE((SELECT SUM(c.patient_payable) FROM bills c
                            WHERE c.original_bill_id = b.id), 0) AS credited,
                 COALESCE((SELECT SUM(x.amount) FROM payments x JOIN bills c ON c.id = x.bill_id
                            WHERE c.original_bill_id = b.id), 0) AS refunded
        ) m
       WHERE b.visit_id = a.id AND b.bill_type = 'invoice'
    ) bs ON TRUE`;

function billState(r) {
  const due = paise(r.due);
  if (due > 0) return { state: STATE.DUE, due };
  if (r.drafts > 0) return { state: STATE.DRAFT, due: 0 };
  if (r.pending_claims > 0) return { state: STATE.CLAIM_PENDING, due: 0 };
  if (r.cleared_claims > 0) return { state: STATE.CLAIM_CLEARED, due: 0 };
  if (r.finals > 0) return { state: STATE.PAID, due: 0 };
  return { state: STATE.NONE, due: 0 };
}

const OPEN_BILL_STATES = [STATE.DUE, STATE.DRAFT, STATE.CLAIM_PENDING];

const notArrived = (row) => EXPECTED_STATUSES.includes(row.status);
const notComing = (row) => NOT_COMING_STATUSES.includes(row.status);
const leftToday = (row) => FINISHED_STATUSES.includes(row.status);

const byArrival = (a, b) =>
  (a.checkedInAt || "").localeCompare(b.checkedInAt || "") ||
  (a.slot || "").localeCompare(b.slot || "");

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

  const patients = visible
    .map((r) => ({
      ...shapeArrival(r, now),
      online: Boolean(r.online),
      samplesOnly: Boolean(r.samples_only),
      bill: billState(r),
    }))
    .filter((row) => !notComing(row) || OPEN_BILL_STATES.includes(row.bill.state));

  return {
    date,
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
