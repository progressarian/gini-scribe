import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// ── GET /api/dashboard ─────────────────────────────────────────────────────
// Returns aggregated clinical outcomes for a period.
// Query params:
//   period=today|yesterday|week|month|lastmonth
//   from=YYYY-MM-DD&to=YYYY-MM-DD (custom range)
//   from=all (all time)

router.get("/dashboard", async (req, res) => {
  try {
    const { period, from, to } = req.query;

    // ── 1. Determine date range ──
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    let dateFrom, dateTo, label;

    if (from === "all") {
      dateFrom = "2000-01-01";
      dateTo = todayStr;
      label = "All Time";
    } else if (from && to) {
      dateFrom = from;
      dateTo = to;
      label = `${from} — ${to}`;
    } else {
      switch (period) {
        case "yesterday": {
          const y = new Date(now);
          y.setDate(y.getDate() - 1);
          dateFrom = dateTo = y.toISOString().split("T")[0];
          label = "Yesterday";
          break;
        }
        case "week": {
          const d = now.getDay();
          const mon = new Date(now);
          mon.setDate(mon.getDate() - (d === 0 ? 6 : d - 1));
          dateFrom = mon.toISOString().split("T")[0];
          dateTo = todayStr;
          label = "This Week";
          break;
        }
        case "month": {
          dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
          dateTo = todayStr;
          label = "This Month";
          break;
        }
        case "lastmonth": {
          const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
          dateFrom = lm.toISOString().split("T")[0];
          dateTo = lmEnd.toISOString().split("T")[0];
          label = "Last Month";
          break;
        }
        default: {
          dateFrom = dateTo = todayStr;
          label = "Today";
        }
      }
    }

    // ── 2. Get unique patients from appointments in the period ──
    const apptR = await pool.query(
      `SELECT DISTINCT ON (COALESCE(a.patient_id, p.id))
              COALESCE(a.patient_id, p.id) AS patient_id,
              p.name, p.file_no, p.phone, p.age, p.sex,
              a.id AS appointment_id, a.appointment_date, a.status, a.category,
              a.doctor_name, a.time_slot, a.biomarkers,
              a.compliance
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       WHERE a.appointment_date >= $1::date AND a.appointment_date <= $2::date
       ORDER BY COALESCE(a.patient_id, p.id), a.appointment_date DESC`,
      [dateFrom, dateTo],
    );

    const patients = apptR.rows.filter((r) => r.patient_id);
    const patientIds = patients.map((p) => p.patient_id);

    if (patientIds.length === 0) {
      return res.json({
        period: { from: dateFrom, to: dateTo, label },
        stats: { totalPatients: 0, withHba1c: 0, atTarget: 0, uncontrolled: 0, risingTrend: 0, missingData: 0, controlRate: 0, coverageRate: 0 },
        distribution: [0, 0, 0, 0, 0],
        needsAttention: [],
        onTrack: [],
        visitFlow: dateFrom === dateTo && dateTo === todayStr ? { seen: 0, withDoctor: 0, waiting: 0, ready: 0, pending: 0 } : null,
        healthraySyncedAt: null,
      });
    }

    // ── 3. Get latest HbA1c for each patient (and previous for trend) ──
    const labsR = await pool.query(
      `SELECT DISTINCT ON (patient_id)
              patient_id, result, test_date
       FROM lab_results
       WHERE patient_id = ANY($1::int[])
         AND COALESCE(canonical_name, test_name) IN ('HbA1c', 'hb_a1c', 'Glycated Hemoglobin', 'A1c', 'HBA1C')
         AND result IS NOT NULL
       ORDER BY patient_id, test_date DESC, created_at DESC`,
      [patientIds],
    );
    const latestHba1c = new Map();
    for (const r of labsR.rows) latestHba1c.set(r.patient_id, { value: parseFloat(r.result), date: r.test_date });

    // Previous HbA1c (second most recent) for trend
    const prevLabsR = await pool.query(
      `SELECT DISTINCT ON (patient_id) patient_id, result, test_date
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY test_date DESC, created_at DESC) AS rn
         FROM lab_results
         WHERE patient_id = ANY($1::int[])
           AND COALESCE(canonical_name, test_name) IN ('HbA1c', 'hb_a1c', 'Glycated Hemoglobin', 'A1c', 'HBA1C')
           AND result IS NOT NULL
       ) sub WHERE rn = 2
       ORDER BY patient_id`,
      [patientIds],
    );
    const prevHba1c = new Map();
    for (const r of prevLabsR.rows) prevHba1c.set(r.patient_id, { value: parseFloat(r.result), date: r.test_date });

    // ── 4. Compute stats ──
    let withHba1c = 0, atTarget = 0, uncontrolled = 0, risingTrend = 0, missingData = 0;
    const distribution = [0, 0, 0, 0, 0]; // ≤7, 7-8, 8-9, 9-10, >10
    const needsAttention = [];
    const onTrack = [];

    for (const p of patients) {
      const latest = latestHba1c.get(p.patient_id);
      const prev = prevHba1c.get(p.patient_id);
      const compliance = p.compliance?.medPct ?? null;

      if (!latest) {
        missingData++;
        needsAttention.push({
          patientId: p.patient_id, name: p.name, fileNo: p.file_no,
          latestHba1c: null, prevHba1c: null, trend: null, compliance,
          lastVisit: p.appointment_date, urgencyReason: "Missing data — no HbA1c on file",
          priority: 5, doctor: p.doctor_name, category: p.category,
        });
        continue;
      }

      withHba1c++;
      const v = latest.value;

      // Distribution
      if (v <= 7) distribution[0]++;
      else if (v <= 8) distribution[1]++;
      else if (v <= 9) distribution[2]++;
      else if (v <= 10) distribution[3]++;
      else distribution[4]++;

      // Control
      if (v <= 7) atTarget++;
      if (v > 9) uncontrolled++;

      // Trend
      const isRising = prev && v > prev.value;
      if (isRising) risingTrend++;

      // Classify into needs attention vs on track
      const row = {
        patientId: p.patient_id, name: p.name, fileNo: p.file_no,
        latestHba1c: v, latestDate: latest.date,
        prevHba1c: prev?.value || null, prevDate: prev?.date || null,
        trend: !prev ? "first" : v > prev.value ? "rising" : v < prev.value ? "falling" : "stable",
        compliance, lastVisit: p.appointment_date, doctor: p.doctor_name, category: p.category,
      };

      if (v > 9 && isRising) {
        needsAttention.push({ ...row, urgencyReason: "Uncontrolled + worsening — urgent", priority: 0 });
      } else if (v > 9) {
        needsAttention.push({ ...row, urgencyReason: "Uncontrolled — HbA1c > 9%", priority: 1 });
      } else if (isRising && prev && v > prev.value) {
        needsAttention.push({ ...row, urgencyReason: "Rising trend — needs regimen review", priority: 2 });
      } else if (compliance != null && compliance < 60) {
        needsAttention.push({ ...row, urgencyReason: "Low compliance — discuss barriers", priority: 3 });
      } else if (v > 7 && v <= 9 && prev && v >= prev.value) {
        needsAttention.push({ ...row, urgencyReason: "Stuck — not progressing", priority: 4 });
      } else if (v <= 7.5) {
        onTrack.push(row);
      }
    }

    // Sort needs attention by priority, on track by HbA1c ascending
    needsAttention.sort((a, b) => a.priority - b.priority);
    onTrack.sort((a, b) => (a.latestHba1c || 0) - (b.latestHba1c || 0));

    // ── 5. Visit flow (today only) ──
    let visitFlow = null;
    if (dateFrom === dateTo && dateTo === todayStr) {
      const allAppts = await pool.query(
        `SELECT status FROM appointments WHERE appointment_date = $1::date`,
        [todayStr],
      );
      const flow = { seen: 0, withDoctor: 0, waiting: 0, ready: 0, pending: 0 };
      for (const a of allAppts.rows) {
        switch (a.status) {
          case "seen":
          case "completed":
            flow.seen++;
            break;
          case "in_visit":
            flow.withDoctor++;
            break;
          case "checkedin":
            flow.waiting++;
            break;
          default:
            flow.pending++;
        }
      }
      visitFlow = flow;
    }

    // ── 6. Last HealthRay sync ──
    let healthraySyncedAt = null;
    try {
      const syncR = await pool.query(
        `SELECT MAX(updated_at) AS last_sync FROM appointments WHERE source = 'healthray'`,
      );
      healthraySyncedAt = syncR.rows[0]?.last_sync || null;
    } catch {}

    const totalPatients = patients.length;
    const controlRate = withHba1c > 0 ? Math.round((atTarget / withHba1c) * 100) : 0;
    const coverageRate = totalPatients > 0 ? Math.round((withHba1c / totalPatients) * 100) : 0;

    res.json({
      period: { from: dateFrom, to: dateTo, label },
      stats: { totalPatients, withHba1c, atTarget, uncontrolled, risingTrend, missingData, controlRate, coverageRate },
      distribution,
      needsAttention,
      onTrack,
      visitFlow,
      healthraySyncedAt,
    });
  } catch (err) {
    handleError(res, err, "Dashboard");
  }
});

export default router;
