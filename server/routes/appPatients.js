// ── App (Genie) patients admin list ─────────────────────────────────────────
// GET /api/app-patients/non-gini — everyone registered in the mobile app who
// is NOT a real Gini hospital patient. Classified by FILE NUMBER, not the
// migrated_to_gini flag: uploading a report during onboarding auto-creates a
// GNI- shell record and flips that flag, but the person is still an app-only
// user. So:
//   • no scribe link at all            → show
//   • linked to a GNI- shell           → show (app-origin)
//   • linked to a real record (P_xxx)  → hide (actual hospital patient)
// Doctor sessions only.
import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { getGenieDb } from "../services/genieImport.js";

const router = Router();

router.get("/app-patients/non-gini", async (req, res) => {
  try {
    if (!req.doctor) return res.status(403).json({ error: "Doctor account required" });
    const db = getGenieDb();
    if (!db) return res.status(503).json({ error: "App DB not configured" });

    const { data: patients, error } = await db
      .from("patients")
      .select(
        "id, name, phone, dob, sex, blood_group, created_at, profile_complete, gini_patient_id, migrated_to_gini",
      )
      .order("created_at", { ascending: false });
    if (error) return res.status(502).json({ error: error.message });

    // Resolve numeric scribe links in one query so GNI- shells can be told
    // apart from real hospital records.
    const numericIds = [
      ...new Set(
        (patients || [])
          .map((p) => p.gini_patient_id)
          .filter((v) => v && /^\d+$/.test(v))
          .map(Number),
      ),
    ];
    const fileNoById = new Map();
    if (numericIds.length) {
      const { rows } = await pool.query(
        `SELECT id, file_no FROM patients WHERE id = ANY($1::int[])`,
        [numericIds],
      );
      for (const r of rows) fileNoById.set(r.id, r.file_no || "");
    }

    const isAppOnly = (p) => {
      if (!p.gini_patient_id) return true; // never touched hospital
      if (/^\d+$/.test(p.gini_patient_id)) {
        const fn = fileNoById.get(Number(p.gini_patient_id));
        // Unresolvable link (deleted scribe row) counts as app-only;
        // GNI- shells are app-origin; anything else is a real patient.
        return !fn || fn.toUpperCase().startsWith("GNI-");
      }
      return false; // legacy file_no-style link (P_xxx) → hospital patient
    };

    const out = (patients || []).filter(isAppOnly).map((p) => ({
      genie_id: p.id,
      name: p.name,
      phone: p.phone,
      dob: p.dob,
      sex: p.sex,
      created_at: p.created_at,
      profile_complete: !!p.profile_complete,
      counts: {},
    }));

    // Per-patient data counts — one batched query per table (not per patient),
    // tallied here. Missing tables resolve to empty defensively.
    const ids = out.map((p) => p.genie_id);
    if (ids.length) {
      const TABLES = {
        chats: "chat_messages",
        meals: "meal_logs",
        activity: "activity_logs",
        symptoms: "symptom_logs",
        med_logs: "medication_logs",
        vitals: "vitals",
        labs: "lab_results",
        medications: "medications",
        conditions: "conditions",
        documents: "patient_documents",
      };
      const byId = new Map(out.map((p) => [p.genie_id, p.counts]));
      await Promise.all(
        Object.entries(TABLES).map(async ([key, table]) => {
          const { data } = await db
            .from(table)
            .select("patient_id")
            .in("patient_id", ids)
            .limit(20000)
            .then(
              (r) => r,
              () => ({ data: [] }),
            );
          for (const row of data || []) {
            const c = byId.get(row.patient_id);
            if (c) c[key] = (c[key] || 0) + 1;
          }
        }),
      );
    }

    res.json({ data: out, total: out.length });
  } catch (e) {
    handleError(res, e, "App patients list");
  }
});

// GET /api/app-patients/:genieId/logs — the actual recent rows behind the
// counts, for the expandable chevron on the App Patients page. Up to 30 most
// recent entries per category. Chat content is deliberately NOT included
// (counts only on the list); use Genie Chats for reading conversations.
// Doctor sessions only.
router.get("/app-patients/:genieId/logs", async (req, res) => {
  try {
    if (!req.doctor) return res.status(403).json({ error: "Doctor account required" });
    const db = getGenieDb();
    if (!db) return res.status(503).json({ error: "App DB not configured" });

    const genieId = String(req.params.genieId || "");
    if (!/^[0-9a-fA-F-]{32,36}$/.test(genieId)) {
      return res.status(400).json({ error: "Invalid patient id" });
    }

    const TABLES = {
      meals: "meal_logs",
      activity: "activity_logs",
      symptoms: "symptom_logs",
      med_logs: "medication_logs",
      vitals: "vitals",
      labs: "lab_results",
      medications: "medications",
      conditions: "conditions",
      documents: "patient_documents",
    };

    const out = {};
    await Promise.all(
      Object.entries(TABLES).map(async ([key, table]) => {
        // Try newest-first; some tables may lack created_at — fall back to
        // unordered, and to [] when the table itself is missing.
        let { data, error } = await db
          .from(table)
          .select("*")
          .eq("patient_id", genieId)
          .order("created_at", { ascending: false })
          .limit(30)
          .then(
            (r) => r,
            () => ({ data: null, error: true }),
          );
        if (error || !data) {
          const fb = await db
            .from(table)
            .select("*")
            .eq("patient_id", genieId)
            .limit(30)
            .then(
              (r) => r,
              () => ({ data: [] }),
            );
          data = fb.data || [];
        }
        out[key] = data;
      }),
    );

    res.json(out);
  } catch (e) {
    handleError(res, e, "App patient logs");
  }
});

export default router;
