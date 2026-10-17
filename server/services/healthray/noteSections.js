import pool from "../../config/db.js";

const lines = (note) =>
  String(note || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());

const DIAGNOSIS_HEADER = /^diagnos[ie]s\s*[:\-]*$/i;

const HISTORY_STOP =
  /^(previous medications?|prev\.? medications?|medications?|treatment|observations?|on examination|o\/e|follow[\s-]*up|goals?|tasks?|advice|investigations?|vitals|current medications?|rx)\b/i;

const HISTORY_NOISE = /^(covid\b.*|vaccination\b.*|nil|na|-+)$/i;

const SUB_HEADER =
  /^((past|family|surgical|personal|drug|menstrual|obstetric)\s+(h\/o|history)|allerg(y|ies))\s*[:\-]*\s*(.*)$/i;

export function historyFromNote(note) {
  const all = lines(note);
  let i = all.findIndex((l) => DIAGNOSIS_HEADER.test(l));
  if (i < 0) return null;
  i += 1;
  while (i < all.length && all[i]) i += 1;
  const out = [];
  for (; i < all.length; i += 1) {
    const line = all[i];
    const last = out[out.length - 1];
    if (!line) {
      if (last) last.closed = true;
      continue;
    }
    if (HISTORY_STOP.test(line)) break;
    if (HISTORY_NOISE.test(line)) continue;
    const sub = line.match(SUB_HEADER);
    if (sub) {
      out.push({ head: sub[1].toUpperCase(), items: sub[5] ? [sub[5]] : [] });
      continue;
    }
    if (last && !last.closed) last.items.push(line);
    else out.push({ head: null, items: [line] });
  }
  const text = out
    .filter((g) => g.items.length)
    .map((g) => (g.head ? `${g.head}: ${g.items.join(", ")}` : g.items.join(". ")))
    .join("\n")
    .trim();
  return text || null;
}

const REFERRAL = /\b(consult(?:ation)?\s+with|refer(?:red)?\s+to|opinion)\b/i;

const NOT_A_REFERRAL =
  /\bconsult(?:ation)?\s+within\b|\b(video|online|tele)\s*consult|\bopinion\s+(was\s+)?(done|taken|given)\b|\bopinion\s*[:\-]\s*\S/i;

const SPECIALIST =
  /\b([a-z]+(?:ologist|iatrist|ician|surgeon|ist)|ortho(?:paedic|pedic)?|ent|gyn(?:a?ecolog)\w*|dermatolog\w*|neurolog\w*|cardiolog\w*|urolog\w*|ophthalmolog\w*|opthalmolog\w*|rheumatolog\w*|nephrolog\w*|gastroenterolog\w*|hematolog\w*|haematolog\w*|oncolog\w*|psychiatr\w*|pulmonolog\w*)\b/i;

const PLAN_START = /^(treatment|rx|medications?)\s*[:\-]*$/i;
const DATED_FOLLOW_UP = /^follow[\s-]*up\b.*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/i;

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

export function referralsFromNote(note) {
  const all = lines(note);
  const lastIndex = (re) => all.reduce((at, l, i) => (re.test(l) ? i : at), -1);
  const start = Math.max(lastIndex(PLAN_START), lastIndex(DATED_FOLLOW_UP), 0);
  const seen = new Set();
  const out = [];
  for (const line of all.slice(start)) {
    if (!REFERRAL.test(line) || NOT_A_REFERRAL.test(line)) continue;
    const reason = line.replace(/^advi[cs]e\b\s*[:\-]*\s*/i, "").replace(/^[-•*]\s*/, "");
    const key = reason.toLowerCase();
    if (!reason || seen.has(key)) continue;
    seen.add(key);
    const specialist = reason.match(SPECIALIST)?.[1];
    out.push({
      type: "referral",
      specialty: specialist ? titleCase(specialist) : "Referral",
      reason,
    });
  }
  return out;
}

export async function healthrayNoteSections(patientId, day, db = pool) {
  const [{ rows: notes }, { rows: scribe }] = await Promise.all([
    db.query(
      `SELECT healthray_clinical_notes AS note
         FROM appointments
        WHERE patient_id = $1
          AND appointment_date <= $2::date
          AND length(COALESCE(healthray_clinical_notes, '')) > 20
          AND COALESCE(status, '') <> 'cancelled'
        ORDER BY appointment_date DESC, id DESC
        LIMIT 1`,
      [patientId, day],
    ),
    db
      .query(
        `SELECT r.doctor_name, r.speciality, r.reason
           FROM referrals r
          WHERE r.patient_id = $1
            AND COALESCE(r.status, '') <> 'cancelled'
            AND r.appointment_id = (
                  SELECT a.id FROM appointments a
                   WHERE a.patient_id = $1 AND a.appointment_date <= $2::date
                     AND COALESCE(a.status, '') <> 'cancelled'
                   ORDER BY a.appointment_date DESC, a.id DESC
                   LIMIT 1)
          ORDER BY r.created_at`,
        [patientId, day],
      )
      .catch(() => ({ rows: [] })),
  ]);
  const note = notes[0]?.note;
  return {
    history: note ? historyFromNote(note) : null,
    referrals: [
      ...scribe.map((r) => ({
        type: "referral",
        specialty: r.speciality,
        referred_to: r.doctor_name,
        reason: r.reason,
      })),
      ...(note ? referralsFromNote(note) : []),
    ],
  };
}
