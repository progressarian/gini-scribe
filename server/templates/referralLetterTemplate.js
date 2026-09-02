import { escapeHtml as escape, LETTERHEAD_CSS } from "./prescriptionTemplate.js";
import { specialtyLabel, specialtyIcon, urgencyMeta } from "../../shared/giniflowReferrals.js";

// The referral letter — docs/gini-flow/19-REFERRALS-STATION-PLAN.md §7.
//
// The prototype has no letter at all: no template, no preview, no window.print(),
// no @media print. "Referral letter" exists there only as a button that toasts.
// So the letter is designed here, and the one rule it inherits is that it must
// look like the prescription — same `.rx-header`, same hospital line, same
// Instrument Serif / Outfit / DM Mono stack, imported rather than re-typed. A
// letter that looks like it came from somewhere else reads as coming from
// somewhere else.
//
// Rendered by generateReferralLetterPdf() in services/prescriptionHtmlPdf.js,
// which shares the one warm Chromium rather than launching a second.

const LETTER_CSS = `
.rl-body{padding:20px 22px}
.rl-date{font-family:var(--fm);font-size:11px;color:var(--ink3);margin-bottom:14px;display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.rl-ref{font-weight:500;color:var(--ink2)}
.rl-to-lbl{font-size:9.5px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.rl-to-name{font-size:15px;font-weight:700;color:var(--nv)}
.rl-to-meta{font-size:11.5px;color:var(--ink2);margin-top:2px}
.rl-to{margin-bottom:16px}
.rl-re{background:var(--bg);border-left:3px solid var(--tl);border-radius:var(--r);padding:10px 12px;margin-bottom:16px}
.rl-re-name{font-size:13.5px;font-weight:700;color:var(--ink)}
.rl-re-meta{font-family:var(--fm);font-size:11px;color:var(--ink3);margin-top:2px}
.rl-sec{margin-bottom:15px;break-inside:avoid}
.rl-sec-title{font-size:9.5px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid var(--bd)}
.rl-text{font-size:12px;color:var(--ink2);line-height:1.65;white-space:pre-wrap}
.rl-inv{display:flex;flex-wrap:wrap;gap:5px}
.rl-list{margin:0;padding-left:16px;font-size:12px;color:var(--ink2);line-height:1.7}
.rl-list em{color:var(--ink3);font-style:normal}
.rl-unknown{color:var(--amb)}
.rl-tbl{width:100%;border-collapse:collapse;font-size:11.5px}
.rl-tbl th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:var(--ink3);font-weight:700;padding:0 8px 4px 0;border-bottom:1px solid var(--bd)}
.rl-tbl td{padding:4px 8px 4px 0;border-bottom:1px solid var(--bg);color:var(--ink2);font-family:var(--fm)}
.rl-tbl td em{font-style:normal;color:var(--ink3);font-size:10px}
.rl-sign-prep{font-size:10px;color:var(--ink3);margin-top:3px}
.rl-inv span{font-family:var(--fm);font-size:10.5px;font-weight:500;color:var(--ink2);background:var(--bg);border:1px solid var(--bd);border-radius:20px;padding:2px 9px}
.rl-med{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--bd)}
.rl-med:last-child{border-bottom:none}
.rl-med-num{font-family:var(--fm);font-size:10px;color:var(--ink3);min-width:16px}
.rl-med-name{flex:1;font-size:12px;font-weight:600;color:var(--ink)}
.rl-med-dose{font-family:var(--fm);font-size:11px;color:var(--ink2);text-align:right;white-space:nowrap}
.rl-med-note{font-size:10px;color:var(--ink3);margin-top:1px;font-weight:400}
.rl-none{font-size:11.5px;color:var(--ink3);font-style:italic}
.rl-sign{margin-top:22px;display:flex;justify-content:space-between;gap:16px;align-items:flex-end;break-inside:avoid}
.rl-sign-name{font-size:13px;font-weight:700;color:var(--nv)}
.rl-sign-cred{font-size:10.5px;color:var(--ink3);line-height:1.6;margin-top:2px}
.rl-reply{font-size:10.5px;color:var(--ink2);background:var(--tll);border:1px solid var(--tlb);border-radius:var(--r);padding:8px 11px;line-height:1.6;max-width:290px}
.rl-urg{font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px}
.rl-urg-routine{background:var(--bg);color:var(--ink2)}
.rl-urg-soon{background:var(--aml);color:var(--am)}
.rl-urg-urgent,.rl-urg-emergency{background:var(--rel);color:var(--re)}
`;

const HOSPITAL_PHONE = "+91 81463 20100";

const fmtDateTime = (value) =>
  new Date(value || Date.now()).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

// DOB prints as a date, never as a locale string with a weekday — a receiving
// clinic matches it character by character against their own record.
const fmtDob = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
};

const fmtDate = (value) =>
  new Date(value || Date.now()).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

// "e.g. HbA1c, UACR, eGFR, Retinopathy report from Oct 2025" is one free-text
// field on the form, so the letter splits it the way it was typed rather than
// demanding the desk enter a structured list.
const splitInvestigations = (raw) =>
  String(raw || "")
    .split(/[,\n·;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const patientLine = (patient = {}) =>
  [
    patient.age ? `${patient.age}${(patient.sex || "").slice(0, 1).toUpperCase()}` : null,
    fmtDob(patient.dob) ? `DOB ${fmtDob(patient.dob)}` : null,
    patient.fileNo || patient.file_no,
    patient.phone,
  ]
    .filter(Boolean)
    .join(" · ");

export function buildReferralLetterHtml(data = {}) {
  const {
    referral = {},
    patient = {},
    doctor = {},
    medicines = [],
    history = [],
    allergies = null,
    findings = null,
    trend = [],
  } = data;

  // Three states, and each says something different to a prescriber. "Not asked"
  // must never render as an empty line, because an empty allergy field on a
  // letter reads as "none".
  const allergyText =
    allergies?.status === "known" && allergies.note
      ? { label: allergies.note, unknown: false }
      : allergies?.status === "none_known"
        ? { label: "None known — asked at referral", unknown: false }
        : { label: "NOT ASKED — please check with the patient before prescribing", unknown: true };

  // Only what the chart actually holds. A findings row for a value nobody
  // measured would be a fabricated observation on a clinical document.
  const findingRows = !findings
    ? []
    : [
        findings.bp ? `BP ${findings.bp} mmHg` : null,
        findings.pulse ? `Pulse ${findings.pulse}` : null,
        findings.spo2 ? `SpO₂ ${findings.spo2}%` : null,
        findings.temp ? `Temp ${findings.temp}` : null,
        findings.weight ? `Weight ${findings.weight} kg` : null,
        findings.bmi ? `BMI ${findings.bmi}` : null,
      ].filter(Boolean);

  const specialty = specialtyLabel(referral.specialty);
  const urgency = urgencyMeta(referral.urgency);
  const investigations = splitInvestigations(referral.investigations);

  const addressee = referral.toDoctor
    ? escape(referral.toDoctor)
    : `The Consultant — ${escape(specialty)}`;

  const credLines = [doctor.qualification, doctor.designation, doctor.registration]
    .filter(Boolean)
    .map((l) => escape(l))
    .join("<br>");

  const medsHtml = medicines.length
    ? medicines
        .map(
          (m, i) => `
    <div class="rl-med">
      <div class="rl-med-num">${i + 1}</div>
      <div class="rl-med-name">${escape(m.name || "")}${
        m.composition ? `<div class="rl-med-note">${escape(m.composition)}</div>` : ""
      }${m.external && m.prescriber ? `<div class="rl-med-note">Prescribed by ${escape(m.prescriber)}</div>` : ""}</div>
      <div class="rl-med-dose">${escape([m.dose, m.frequency].filter(Boolean).join(" · ") || "—")}${
        m.timing ? `<div class="rl-med-note">${escape(m.timing)}</div>` : ""
      }</div>
    </div>`,
        )
        .join("")
    : `<div class="rl-none">No active medicines recorded.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Referral letter</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${LETTERHEAD_CSS}${LETTER_CSS}</style>
</head>
<body>
<div class="rx-page">
  <div class="rx-header">
    <div>
      <div class="rx-hosp-name">Gini Advanced Care Hospital</div>
      <div class="rx-hosp-tag">NABH Accredited · SCO 14-15, Sector 68, SAS Nagar, Mohali 160068 · ${HOSPITAL_PHONE}</div>
    </div>
    <div class="rx-doc">
      <div class="rx-doc-name">${escape(doctor.name || "Doctor")}</div>
      <div class="rx-doc-cred">${credLines || "Gini Advanced Care Hospital"}</div>
    </div>
  </div>

  <div class="rl-body">
    <div class="rl-date">
      <span>${escape(fmtDate(referral.createdAt))}</span>
      ${
        referral.referralNo
          ? `<span class="rl-ref">Ref ${escape(referral.referralNo)} &middot; raised ${escape(fmtDateTime(referral.createdAt))}</span>`
          : ""
      }
    </div>

    <div class="rl-to">
      <div class="rl-to-lbl">Referral to</div>
      <div class="rl-to-name">${specialtyIcon(referral.specialty)} ${addressee}</div>
      <div class="rl-to-meta">${escape(specialty)}${referral.hospital ? ` · ${escape(referral.hospital)}` : ""}</div>
    </div>

    <div class="rl-re">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div>
          <div class="rl-re-name">Re: ${escape(patient.name || "")}</div>
          <div class="rl-re-meta">${escape(patientLine(patient))}</div>
        </div>
        <span class="rl-urg rl-urg-${escape(referral.urgency || "routine")}">${escape(urgency.label)}</span>
      </div>
    </div>

    ${
      String(referral.presentingComplaint || "").trim()
        ? `<div class="rl-sec">
      <div class="rl-sec-title">Presenting complaint</div>
      <div class="rl-text">${escape(referral.presentingComplaint.trim())}</div>
    </div>`
        : ""
    }

    <div class="rl-sec">
      <div class="rl-sec-title">Reason for referral</div>
      <div class="rl-text">${escape(referral.reason || "").trim() || "—"}</div>
    </div>

    ${
      history.length
        ? `<div class="rl-sec">
      <div class="rl-sec-title">Relevant medical history</div>
      <ul class="rl-list">${history
        .map(
          (h) =>
            `<li>${escape(h.label)}${h.since ? ` <em>— since ${escape(String(h.since))}</em>` : ""}</li>`,
        )
        .join("")}</ul>
    </div>`
        : ""
    }

    <!-- Allergies is printed EVEN WHEN EMPTY, and says what is true.
         No allergy field exists in this database, so the honest line is "not
         recorded" — printing "NKDA" would tell a specialist that somebody
         checked, and prescribing against that is exactly the harm this section
         exists to prevent. -->
    <div class="rl-sec">
      <div class="rl-sec-title">Allergies</div>
      <div class="rl-text${allergyText.unknown ? " rl-unknown" : ""}">${escape(allergyText.label)}</div>
    </div>

    ${
      findingRows.length
        ? `<div class="rl-sec">
      <div class="rl-sec-title">Clinical findings${findings.takenAt ? ` · ${escape(fmtDate(findings.takenAt))}` : ""}</div>
      <div class="rl-inv">${findingRows.map((f) => `<span>${escape(f)}</span>`).join("")}</div>
    </div>`
        : ""
    }

    ${
      trend.length
        ? `<div class="rl-sec">
      <div class="rl-sec-title">Key numbers</div>
      <table class="rl-tbl">
        <tr><th>Investigation</th><th>Current</th><th>Previous</th></tr>
        ${trend
          .map(
            (t) =>
              `<tr><td>${escape(t.label)}</td><td><strong>${escape(String(t.current ?? "—"))}${t.current != null && t.unit ? ` ${escape(t.unit)}` : ""}</strong>${t.currentDate ? `<em> · ${escape(fmtDate(t.currentDate))}</em>` : ""}</td><td>${t.previous == null ? "—" : `${escape(String(t.previous))}${t.previousDate ? `<em> · ${escape(fmtDate(t.previousDate))}</em>` : ""}`}</td></tr>`,
          )
          .join("")}
      </table>
    </div>`
        : ""
    }

    ${
      investigations.length
        ? `<div class="rl-sec">
      <div class="rl-sec-title">Key investigations to share</div>
      <div class="rl-inv">${investigations.map((i) => `<span>${escape(i)}</span>`).join("")}</div>
    </div>`
        : ""
    }

    <!-- The specialist needs to know what the patient is already on BEFORE they
         prescribe. This is the same medicine history the card and the
         prescription read — there is no second one. -->
    <div class="rl-sec">
      <div class="rl-sec-title">Current medicines</div>
      ${medsHtml}
    </div>

    ${
      String(referral.requestedAction || "").trim()
        ? `<div class="rl-sec">
      <div class="rl-sec-title">Requested specialist action</div>
      <div class="rl-text">${escape(referral.requestedAction.trim())}</div>
    </div>`
        : ""
    }

    <div class="rl-sign">
      <div>
        <div class="rl-sign-name">${escape(doctor.name || "Doctor")}</div>
        <div class="rl-sign-cred">${credLines || "Gini Advanced Care Hospital"}</div>
        <div class="rl-sign-cred">${doctor.phone ? `${escape(doctor.phone)} &middot; ` : ""}${HOSPITAL_PHONE}</div>
        ${
          doctor.preparedBy
            ? `<div class="rl-sign-prep">Letter prepared by ${escape(doctor.preparedBy)}</div>`
            : ""
        }
      </div>
      <div class="rl-reply">
        Please reply with your assessment and any medicine changes to
        <strong>${doctor.phone ? escape(doctor.phone) : HOSPITAL_PHONE}</strong>${
          referral.referralNo ? `, quoting <strong>${escape(referral.referralNo)}</strong>,` : ""
        } so the patient's record here stays complete.
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

export default buildReferralLetterHtml;
