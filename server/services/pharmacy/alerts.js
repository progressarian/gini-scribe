import pool from "../../config/db.js";
import { CAPABILITIES as CAP } from "../../../shared/permissions.js";
import {
  raiseNotification,
  resolveNotifications,
  resolveNotificationsLike,
} from "../notifications.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const LOW = "pharmacy:low:";
const OVER = "pharmacy:over:";
const EXPIRED = "pharmacy:expired:";
const EXPIRING = "pharmacy:expiring:";
const DRIFT = "pharmacy:drift";

const LEVELS_SQL = (pairs) => `
  WITH pairs AS (${pairs})
  SELECT p.location_id, p.medicine_id, l.kind, l.name AS location_name, m.name, m.unit_label,
         CASE WHEN l.kind = 'main' THEN m.min_stock_units ELSE ll.min_units END AS min_units,
         CASE WHEN l.kind = 'main' THEN m.max_stock_units ELSE ll.max_units END AS max_units,
         COALESCE((SELECT SUM(s.qty_units) FROM pharmacy_stock s
                     JOIN pharmacy_batches b ON b.id = s.batch_id
                    WHERE s.location_id = p.location_id AND b.medicine_id = p.medicine_id
                      AND b.expiry_date > $1::date), 0)::int AS units
    FROM pairs p
    JOIN pharmacy_locations l ON l.id = p.location_id AND l.is_active
    JOIN pharmacy_medicines m ON m.id = p.medicine_id AND m.is_active
    LEFT JOIN pharmacy_location_levels ll
           ON ll.location_id = p.location_id AND ll.medicine_id = p.medicine_id
   ORDER BY p.location_id, p.medicine_id`;

const GIVEN_PAIRS = `SELECT * FROM unnest($2::int[], $3::int[]) AS x(location_id, medicine_id)`;

const ALL_PAIRS = `
  SELECT l.id AS location_id, m.id AS medicine_id
    FROM pharmacy_medicines m CROSS JOIN pharmacy_locations l
   WHERE l.kind = 'main' AND (m.min_stock_units IS NOT NULL OR m.max_stock_units IS NOT NULL)
  UNION
  SELECT location_id, medicine_id FROM pharmacy_location_levels
   WHERE min_units IS NOT NULL OR max_units IS NOT NULL`;

const link = (row) =>
  `/pharmacy/stock?location_id=${row.location_id}&q=${encodeURIComponent(row.name)}&filter=`;

async function applyLevels(db, rows) {
  const open = { low: [], over: [] };
  for (const row of rows) {
    const key = `${row.location_id}:${row.medicine_id}`;
    const where = row.kind === "main" ? "the main pharmacy" : row.location_name;
    const capability = row.kind === "main" ? CAP.PHARMACY_PURCHASE : CAP.PHARMACY_DEPT_MANAGE;
    if (row.min_units !== null && row.units < row.min_units) {
      open.low.push(LOW + key);
      await raiseNotification(db, {
        kind: row.kind === "main" ? "stock_low" : "dept_stock_low",
        severity: row.units === 0 ? "critical" : "warning",
        capability,
        title: row.units === 0 ? `Out of stock: ${row.name}` : `Low stock: ${row.name}`,
        body: `${row.units} ${row.unit_label} left at ${where}; the minimum is ${row.min_units}.`,
        link: `${link(row)}${row.units === 0 ? "out" : "low"}`,
        entityType: "pharmacy_medicines",
        entityId: row.medicine_id,
        dedupeKey: LOW + key,
      });
    } else {
      await resolveNotifications(db, LOW + key);
    }
    if (row.max_units !== null && row.units > row.max_units) {
      open.over.push(OVER + key);
      await raiseNotification(db, {
        kind: "stock_over_max",
        severity: "info",
        capability,
        title: `Over stock: ${row.name}`,
        body: `${row.units} ${row.unit_label} at ${where}; the maximum is ${row.max_units}.`,
        link: `${link(row)}over`,
        entityType: "pharmacy_medicines",
        entityId: row.medicine_id,
        dedupeKey: OVER + key,
      });
    } else {
      await resolveNotifications(db, OVER + key);
    }
  }
  return open;
}

export async function checkStockLevels(db, pairs) {
  const unique = [
    ...new Map(pairs.map((p) => [`${p.locationId}:${p.medicineId}`, p])).values(),
  ].sort((a, b) => a.locationId - b.locationId || a.medicineId - b.medicineId);
  if (!unique.length) return;
  const { rows } = await db.query(LEVELS_SQL(GIVEN_PAIRS), [
    today(),
    unique.map((p) => p.locationId),
    unique.map((p) => p.medicineId),
  ]);
  const byKey = new Map(rows.map((r) => [`${r.location_id}:${r.medicine_id}`, r]));
  for (const pair of unique) {
    const key = `${pair.locationId}:${pair.medicineId}`;
    const row = byKey.get(key);
    if (row) await applyLevels(db, [row]);
    else await resolveNotifications(db, [LOW + key, OVER + key]);
  }
}

async function sweepLevels(db) {
  const { rows } = await db.query(LEVELS_SQL(ALL_PAIRS), [today()]);
  const open = await applyLevels(db, rows);
  await resolveNotificationsLike(db, LOW, open.low);
  await resolveNotificationsLike(db, OVER, open.over);
  return { low: open.low.length, over: open.over.length };
}

async function sweepExpiry(db) {
  const { rows: settings } = await db.query(
    `SELECT near_expiry_warn_days, expiry_alert_days FROM pharmacy_settings WHERE id`,
  );
  const alertDays = settings[0]?.expiry_alert_days ?? 90;
  const { rows } = await db.query(
    `SELECT l.id AS location_id, l.name, l.kind,
            count(*) FILTER (WHERE b.expiry_date <= $1::date)::int AS expired,
            COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date <= $1::date), 0)::int AS expired_units,
            count(*) FILTER (WHERE b.expiry_date > $1::date
                               AND b.expiry_date <= $1::date + 30)::int AS within_30,
            count(*) FILTER (WHERE b.expiry_date > $1::date
                               AND b.expiry_date <= $1::date + $2::int)::int AS expiring
       FROM pharmacy_stock s
       JOIN pharmacy_batches b ON b.id = s.batch_id
       JOIN pharmacy_locations l ON l.id = s.location_id
      WHERE s.qty_units > 0
      GROUP BY l.id, l.name, l.kind`,
    [today(), alertDays],
  );
  const keep = { expired: [], expiring: [] };
  for (const row of rows) {
    const where = row.kind === "main" ? "the main pharmacy" : row.name;
    if (row.expired) {
      keep.expired.push(EXPIRED + row.location_id);
      await raiseNotification(db, {
        kind: "batch_expired",
        severity: "critical",
        capability: CAP.PHARMACY_PURCHASE,
        title: `${row.expired} expired batch${row.expired === 1 ? "" : "es"} on the shelf`,
        body: `${row.expired_units} units at ${where} have expired. Take them off the shelf and return or write them off.`,
        link: `/pharmacy/expiry?bucket=expired&location_id=${row.location_id}`,
        dedupeKey: EXPIRED + row.location_id,
      });
    }
    if (row.expiring) {
      keep.expiring.push(EXPIRING + row.location_id);
      await raiseNotification(db, {
        kind: "batch_near_expiry",
        severity: row.within_30 ? "warning" : "info",
        capability: CAP.PHARMACY_PURCHASE,
        title: `${row.expiring} batch${row.expiring === 1 ? "" : "es"} expire within ${alertDays} days`,
        body: `At ${where}${row.within_30 ? `, ${row.within_30} of them within 30 days` : ""}. Sell them first or arrange a vendor return.`,
        link: `/pharmacy/expiry?location_id=${row.location_id}`,
        dedupeKey: EXPIRING + row.location_id,
      });
    }
  }
  await resolveNotificationsLike(db, EXPIRED, keep.expired);
  await resolveNotificationsLike(db, EXPIRING, keep.expiring);
  return { expired: keep.expired.length, expiring: keep.expiring.length };
}

async function sweepDrift(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM (
       SELECT s.location_id, s.batch_id
         FROM pharmacy_stock s
         LEFT JOIN (SELECT location_id, batch_id, SUM(delta_units) AS total
                      FROM pharmacy_stock_movements GROUP BY location_id, batch_id) m
                ON m.location_id = s.location_id AND m.batch_id = s.batch_id
        WHERE s.qty_units <> COALESCE(m.total, 0)
     ) d`,
  );
  const drifted = rows[0].n;
  if (drifted) {
    await raiseNotification(db, {
      kind: "stock_drift",
      severity: "critical",
      capability: CAP.PHARMACY_MASTER,
      title: "Stock does not match its history",
      body: `${drifted} batch stock figure${drifted === 1 ? "" : "s"} differ from the sum of their movements. Tell the Scribe team.`,
      link: "/pharmacy/stock",
      dedupeKey: DRIFT,
    });
  } else {
    await resolveNotifications(db, DRIFT);
  }
  return { drifted };
}

export async function runPharmacyAlertSweep(db = pool) {
  return {
    levels: await sweepLevels(db),
    expiry: await sweepExpiry(db),
    drift: await sweepDrift(db),
  };
}
