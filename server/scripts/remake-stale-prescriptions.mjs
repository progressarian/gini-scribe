import "../loadEnv.js";
import pool from "../config/db.js";
import {
  buildVisitPayloadFromDb,
  savePrescriptionForVisit,
} from "../services/prescriptionAutoSave.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const SINCE = arg("since", "2026-09-14");
const BATCH = Math.max(1, Number(arg("batch", 20)) || 20);
const ONLY = new Set(
  String(arg("only", ""))
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean),
);
const SKIP = new Set(
  String(arg("skip", ""))
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean),
);
const apply = process.argv.includes("--apply");

const VISITS_SQL = `
  SELECT a.id AS appointment_id, a.patient_id, a.consultation_id, a.opd_backfilled_at,
         a.appointment_date::text AS visit_date, p.file_no, p.name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
   WHERE a.appointment_date >= $1::date
     AND a.status IN ('completed', 'seen')
     AND a.consultation_id IS NOT NULL
     AND a.opd_backfilled_at IS NOT NULL
     AND ($2::text[] IS NULL OR upper(p.file_no) = ANY($2::text[]))
     AND NOT EXISTS (SELECT 1 FROM appointments later
                      WHERE later.patient_id = a.patient_id
                        AND later.appointment_date > a.appointment_date
                        AND later.status IN ('completed', 'seen'))
   ORDER BY a.appointment_date, p.file_no`;

const LATEST_RX_SQL = `
  SELECT DISTINCT ON (consultation_id) consultation_id, id AS doc_id, created_at AS rx_at,
         extracted_data
    FROM documents
   WHERE consultation_id = ANY($1::int[]) AND doc_type = 'prescription' AND source = 'visit'
   ORDER BY consultation_id, created_at DESC`;

async function staleRows() {
  const { rows: visits } = await pool.query(VISITS_SQL, [
    ONLY.size ? "2000-01-01" : SINCE,
    ONLY.size ? [...ONLY] : null,
  ]);
  const { rows: docs } = await pool.query(LATEST_RX_SQL, [visits.map((v) => v.consultation_id)]);
  const rx = new Map(docs.map((d) => [d.consultation_id, d]));
  return visits
    .map((v) => ({ ...v, ...rx.get(v.consultation_id) }))
    .filter((v) =>
      ONLY.size
        ? v.rx_at && ONLY.has(v.file_no.toUpperCase())
        : v.rx_at && v.rx_at < new Date(new Date(v.opd_backfilled_at).getTime() - 120000),
    );
}

const MISFILED_SQL = `
  SELECT d.id, p.file_no, d.doc_date::text AS doc_date, d.extracted_data->>'rxDate' AS rx_date
    FROM documents d JOIN patients p ON p.id = d.patient_id
   WHERE d.doc_type = 'prescription' AND d.source = 'visit'
     AND d.created_at > NOW() - interval '1 day'
     AND d.extracted_data->>'rxDate' IS NOT NULL
     AND d.doc_date <> (d.extracted_data->>'rxDate')::date`;

const medsOf = (data) =>
  new Set(
    (data?.activeMeds || []).map((m) =>
      `${String(m.name || "")
        .trim()
        .toLowerCase()} ${String(m.dose || "")
        .trim()
        .toLowerCase()}`.trim(),
    ),
  );
const testsOf = (data) =>
  new Set(
    (data?.appt_plan?.investigations_to_order || []).map((t) =>
      String(typeof t === "string" ? t : t?.name || "")
        .trim()
        .toLowerCase(),
    ),
  );
const followUpOf = (data) => data?.appt_plan?.follow_up?.date || null;
const minus = (a, b) => [...a].filter((x) => !b.has(x));

function differences(printed, now) {
  const out = [];
  const pm = medsOf(printed);
  const nm = medsOf(now);
  const gone = minus(pm, nm);
  const added = minus(nm, pm);
  if (gone.length || added.length) {
    out.push(`medicines printed [${gone.join(", ") || "-"}] → now [${added.join(", ") || "-"}]`);
  }
  const pt = testsOf(printed);
  const nt = testsOf(now);
  if (minus(nt, pt).length || minus(pt, nt).length) {
    out.push(`tests ${pt.size} printed → ${nt.size} now`);
  }
  if (followUpOf(printed) !== followUpOf(now)) {
    out.push(`next visit ${followUpOf(printed) || "none"} → ${followUpOf(now) || "none"}`);
  }
  return out;
}

try {
  const stale = (await staleRows()).filter((row) => !SKIP.has(row.file_no.toUpperCase()));
  console.log(
    `${stale.length} latest-visit prescription(s) since ${SINCE} were made before the note was fully read`,
  );
  const toRemake = [];
  let checked = 0;
  for (const row of stale) {
    if (apply && toRemake.length >= BATCH) break;
    checked++;
    const payload = await buildVisitPayloadFromDb(row.patient_id, {
      appointmentId: row.appointment_id,
    });
    const diff = !payload
      ? []
      : ONLY.size
        ? ["remake requested", ...differences(row.extracted_data, payload)]
        : differences(row.extracted_data, payload);
    if (!diff.length) continue;
    toRemake.push({ row, payload });
    console.log(`- ${row.file_no} ${row.name} · visit ${row.visit_date}`);
    for (const d of diff) console.log(`    ${d}`);
  }
  console.log(
    apply
      ? `\nThis batch: ${toRemake.length} to remake (checked ${checked} of ${stale.length}).`
      : `\n${toRemake.length} differ from what Scribe now knows; ${stale.length - toRemake.length} already match.`,
  );

  const { rows: misfiled } = await pool.query(MISFILED_SQL);
  if (misfiled.length) {
    console.log(`${misfiled.length} remade prescription(s) are filed under the wrong date:`);
    for (const m of misfiled)
      console.log(`- ${m.file_no}: filed ${m.doc_date}, visit ${m.rx_date}`);
  }

  if (!apply) {
    console.log(
      `\nPreview only. Run with --apply to remake them ${BATCH} at a time (--batch=N to change).`,
    );
  } else {
    let done = 0;
    let failed = 0;
    for (const { row, payload } of toRemake) {
      try {
        await pool.query(`UPDATE appointments SET post_visit_summary = NULL WHERE id = $1`, [
          row.appointment_id,
        ]);
        await savePrescriptionForVisit(
          row.patient_id,
          { ...payload, visitSummaryText: undefined },
          {
            appointmentId: row.appointment_id,
            consultationId: row.consultation_id,
            source: "visit",
            overwrite: true,
          },
        );
        done++;
        console.log(`  remade ${row.file_no} (${done}/${toRemake.length})`);
      } catch (e) {
        failed++;
        console.error(`  ${row.file_no} not remade: ${e.message}`);
      }
    }
    const { rowCount } = await pool.query(
      `UPDATE documents SET doc_date = (extracted_data->>'rxDate')::date
        WHERE doc_type = 'prescription' AND source = 'visit'
          AND created_at > NOW() - interval '1 day'
          AND extracted_data->>'rxDate' IS NOT NULL
          AND doc_date <> (extracted_data->>'rxDate')::date`,
    );
    console.log(`\nBatch done: remade ${done}, failed ${failed}; ${rowCount} date(s) corrected.`);
    if (checked < stale.length) console.log("Run the same command again for the next batch.");
    else console.log("No more to check — all batches done.");
    if (failed) process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit();
}
