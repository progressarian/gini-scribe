import {
  buildPatientRecord,
  buildPeriods,
  cadAtVisit,
  kidneyAtVisit,
  importedVisit,
  mergeNearbyImported,
  onsetFor,
  parseRawDiagnosis,
  summarise,
  drugFlags,
  isGlp1Advice,
} from "../services/analytics/opdYoy.js";

let failures = 0;
let total = 0;

function check(label, got, expected) {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "pass" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
}

const visit = (over = {}) => ({
  patient_id: 1,
  health_id: "H1",
  day: "2026-03-01",
  visit_age: 50,
  dob: null,
  stored_age: null,
  sex: "Male",
  dx: [],
  meds: [],
  cad_signs: [],
  neph_signs: [],
  ...over,
});
const dx = (name, status = "", details = "", since = "") => ({ name, status, details, since });

check(
  "CAD blank status, note CAD-",
  cadAtVisit(visit({ dx: [dx("cad")], cad_signs: ["-"] })),
  false,
);
check(
  "CAD note CAD- then CAD+ (last wins)",
  cadAtVisit(visit({ dx: [dx("cad")], cad_signs: ["-", "+"] })),
  true,
);
check(
  "CAD p/PTCA with note CAD-",
  cadAtVisit(visit({ dx: [dx("cad p/ptca")], cad_signs: ["-"] })),
  true,
);
check("CAD negative wording", cadAtVisit(visit({ dx: [dx("cad negative")] })), false);
check(
  "Coronary artery disease present",
  cadAtVisit(visit({ dx: [dx("coronary artery disease", "present")] })),
  true,
);
check("CAD absent, no note sign", cadAtVisit(visit({ dx: [dx("cad", "absent")] })), false);
check("CAD blank, no note sign", cadAtVisit(visit({ dx: [dx("cad")] })), false);
check(
  "Gestational MI wording ignored",
  cadAtVisit(visit({ dx: [dx("gestational myocardial infarction de novo")] })),
  false,
);
check(
  "CAD- POST PTCA: name cad, details post ptca",
  cadAtVisit(visit({ dx: [dx("cad", "present", "post ptca 2019")], cad_signs: [] })),
  true,
);
check(
  "CAD with stent in details, note CAD-",
  cadAtVisit(visit({ dx: [dx("cad", "", "s/p stent")], cad_signs: ["-"] })),
  true,
);
check("AOO written as a year", onsetFor([visit({ dx: [dx("type 2 dm", "", "aoo 2015")] })], []), {
  aoo: 39,
  source: "age minus years since diagnosis",
});
check("Since 12 yrs", onsetFor([visit({ dx: [dx("type 2 dm", "", "since 12 yrs")] })], []), {
  aoo: 38,
  source: "age minus years since diagnosis",
});
check(
  "AOO 6 months ignored",
  onsetFor([visit({ dx: [dx("type 2 dm", "", "aoo 6 months")] })], []),
  { aoo: null, source: null },
);
check("CAD+ in note, no CAD entry", cadAtVisit(visit({ cad_signs: ["+"] })), true);

check("Nephropathy G1A1", kidneyAtVisit(visit({ dx: [dx("nephropathy", "", "g1a1")] })), "no");
check(
  "Nephropathy G2A1",
  kidneyAtVisit(visit({ dx: [dx("nephropathy", "present", "g2 a1")] })),
  "no",
);
check("Nephropathy G3aA2", kidneyAtVisit(visit({ dx: [dx("nephropathy", "", "g3aa2")] })), "dkd");
check(
  "Nephropathy G2A2",
  kidneyAtVisit(visit({ dx: [dx("nephropathy", "present", "g2a2")] })),
  "dkd",
);
check("Nephropathy G1A?", kidneyAtVisit(visit({ dx: [dx("nephropathy", "", "g1a?")] })), "unclear");
check("Nephropathy no stage", kidneyAtVisit(visit({ dx: [dx("nephropathy")] })), "unclear");
check(
  "Nephropathy G3aA1 with NEPHROPATHY- in note",
  kidneyAtVisit(visit({ dx: [dx("nephropathy", "", "g3aa1")], neph_signs: ["-"] })),
  "no",
);
check(
  "Nephropathy absent G3aA2, no note sign",
  kidneyAtVisit(visit({ dx: [dx("nephropathy", "absent", "g3aa2")] })),
  "no",
);
check(
  "IgA nephropathy G3aA2",
  kidneyAtVisit(visit({ dx: [dx("iga nephropathy", "", "g3aa2")] })),
  "no",
);
check("CKD stage 3", kidneyAtVisit(visit({ dx: [dx("chronic kidney disease stage 3")] })), "dkd");
check("Renal stone disease", kidneyAtVisit(visit({ dx: [dx("renal stone disease")] })), "no");
check(
  "Diabetic kidney disease, unstaged",
  kidneyAtVisit(visit({ dx: [dx("diabetic kidney disease")] })),
  "unclear",
);

check(
  "AOO written",
  onsetFor([visit({ dx: [dx("type 2 dm", "", "since 2015, aoo 38 yrs")] })], []),
  { aoo: 38, source: "written AOO" },
);
check("AOO from since year", onsetFor([visit({ dx: [dx("type 2 dm", "", "since 2016")] })], []), {
  aoo: 40,
  source: "age minus years since diagnosis",
});
check(
  "AOO above current age dropped",
  onsetFor([visit({ dx: [dx("type 2 dm", "", "aoo 62")] })], []),
  {
    aoo: null,
    source: null,
  },
);
check(
  "AOO from diagnoses table note",
  onsetFor(
    [visit()],
    [
      {
        diagnosis_id: "type_2_diabetes_mellitus",
        label: "type 2 dm",
        notes: "healthray:1 — aoo 35 yrs",
      },
    ],
  ),
  { aoo: 35, source: "written AOO" },
);
check(
  "AOO ignores absent diabetes",
  onsetFor([visit({ dx: [dx("type 2 dm", "absent", "aoo 30")] })], []),
  {
    aoo: null,
    source: null,
  },
);

const periods = buildPeriods("2026-11-10");
check(
  "Periods",
  periods.map((p) => [p.key, p.from, p.to, !!p.history]),
  [
    ["2023", "2023-01-01", "2023-12-31", true],
    ["2024", "2024-01-01", "2024-12-31", true],
    ["2025", "2025-01-01", "2025-12-31", false],
    ["2025-ytd", "2025-01-01", "2025-11-10", false],
    ["2026", "2026-01-01", "2026-11-10", false],
  ],
);

const rawEntries = (t) => parseRawDiagnosis(t).map((e) => [e.name, e.status, e.details]);
check(
  "Raw dx: lines with signs and stages",
  rawEntries("TYPE 2 DM (SINCE 2015), AOO-35YRS\nDUAL ADIPOSITY\nNEPHROPATHY-(G1A1)\nCAD-"),
  [
    ["type 2 dm", "", "(since 2015) aoo-35yrs"],
    ["dual adiposity", "", ""],
    ["nephropathy", "absent", "(g1a1)"],
    ["cad", "absent", ""],
  ],
);
check(
  "Raw dx: comma list",
  rawEntries("T2DM, HTN, DUAL ADIPOSITY").map((e) => e[0]),
  ["t2dm", "htn", "dual adiposity"],
);
check("Raw dx: CAD- POST PTCA is a separator", rawEntries("CAD- POST PTCA (2019)"), [
  ["cad", "", "post ptca (2019)"],
]);
check("Raw dx: plus sign with details", rawEntries("CAD+, NEUROPATHY+(DDSMP)"), [
  ["cad", "present", ""],
  ["neuropathy", "present", "(ddsmp)"],
]);

const imp = importedVisit(
  {
    patient_id: 2,
    day: "2023-05-04",
    dob: null,
    stored_age: 60,
    sex: "Female",
    health_id: "H2",
    uhid: "P_2",
    raw_dx: "TYPE 2 DM, AOO-40 YRS\nDUAL ADIPOSITY\nNEPHROPATHY(G3aA2)\nCAD- POST PTCA",
  },
  2026,
);
check(
  "Run-together 'retinopathycad+' still gives a CAD sign",
  importedVisit(
    {
      patient_id: 3,
      day: "2023-01-05",
      dob: null,
      stored_age: 50,
      sex: "Male",
      health_id: "H3",
      uhid: "P_3",
      raw_dx: "neuropathy+,nephropathy(g1a1),retinopathycad+,cva-",
    },
    2026,
  ).cad_signs,
  ["+"],
);
check("Imported visit: age back-dated from stored age", imp.stored_age, 57);
check("Imported visit: CAD sign ignores POST separator", imp.cad_signs, []);
const impRec = buildPatientRecord(periods[0], [imp], {
  medsByPatient: new Map(),
  diagnosisByPatient: new Map(),
  readingsByPatient: new Map(),
});
check(
  "Imported 2023 record",
  [
    impRec.visits,
    impRec.age,
    impRec.ageSource,
    impRec.diabetic,
    impRec.aoo,
    impRec.dualDx,
    impRec.dkd,
    impRec.cad,
  ],
  [1, 57, "stored", true, 40, true, true, true],
);

const p2026 = periods[4];
const visits = [
  visit({ day: "2025-06-01", dx: [dx("dual adiposity")] }),
  visit({
    day: "2026-01-10",
    meds: ["Inj Semasize 0.25 mg"],
    dx: [dx("type 2 dm", "", "aoo 41"), dx("dual adiposity")],
  }),
  visit({ day: "2026-04-10" }),
  visit({
    day: "2026-08-10",
    dx: [dx("type 2 dm"), dx("nephropathy", "", "g1a3"), dx("cad", "absent")],
  }),
];
const ctx = {
  medsByPatient: new Map([
    [
      1,
      [
        { name: "Awiqli", started: "2025-05-01", last_prescribed: "2026-08-10" },
        { name: "Mounjaro", started: "2024-01-01", last_prescribed: "2024-06-01" },
      ],
    ],
  ]),
  diagnosisByPatient: new Map(),
  readingsByPatient: new Map([
    [
      1,
      {
        hba1c: [
          { d: "2026-02-01", val: 8.1 },
          { d: "2026-07-01", val: 6.8 },
        ],
        sbp: [{ d: "2026-07-01", val: 132 }],
        ldl: [{ d: "2025-07-01", val: 90 }],
        bmi: [{ d: "2026-07-01", val: 29 }],
        waist: [{ d: "2026-07-01", val: 96 }],
      },
    ],
  ]),
};
const rec = buildPatientRecord(p2026, visits, ctx);
check("2026 visits / ≥3 set", [rec.visits, rec.setB], [3, true]);
check("Age from first 2026 visit", [rec.age, rec.ageSource], [50, "visit"]);
check("Diabetic, Type 2, AOO", [rec.diabetic, rec.type2, rec.aoo], [true, true, 41]);
check(
  "GLP-1 from visit Rx, Awiqli from medicine row",
  [rec.glp1, rec.icodec, rec.molecules],
  [true, true, ["semaglutide_inj"]],
);
check(
  "Latest diagnosis list wins: dual adiposity gone",
  [rec.latestListDay, rec.dualDx],
  ["2026-08-10", false],
);
check("Dual adiposity measured", rec.dualMeasured, true);
check("DKD from G1A3, CAD absent", [rec.kidney, rec.dkd, rec.cad], ["dkd", true, false]);
check("Latest HbA1c in period", rec.hba1c, 6.8);
check("LDL outside period not used", rec.ldl, null);

const withImported = buildPatientRecord(
  p2026,
  [
    importedVisit(
      {
        patient_id: 1,
        day: "2023-02-02",
        dob: null,
        stored_age: 50,
        sex: "Male",
        health_id: "H1",
        uhid: "P_1",
        raw_dx: "TYPE 2 DM, AOO-30 YRS",
      },
      2026,
    ),
    ...visits.slice(1).map((v) => ({
      ...v,
      dx: v.dx.map((e) => ({ ...e, details: e.details.replace("aoo 41", "") })),
    })),
  ],
  ctx,
);
check("2025+ periods ignore AOO found only in imported notes", withImported.aoo, null);

const iv = (patient_id, day, raw_dx = "") =>
  importedVisit(
    { patient_id, day, dob: null, stored_age: 50, sex: "Male", health_id: "H", uhid: "P", raw_dx },
    2026,
  );
const merged = mergeNearbyImported([
  iv(5, "2023-03-01"),
  iv(5, "2023-03-03", "CAD+"),
  iv(5, "2023-03-06"),
  iv(5, "2023-04-20"),
  iv(6, "2023-03-02"),
]);
check(
  "Imported dates within 3 days merge into one visit, chained",
  merged.map((v) => [v.patient_id, v.day]),
  [
    [5, "2023-03-01"],
    [5, "2023-04-20"],
    [6, "2023-03-02"],
  ],
);
check("Merged visit keeps the diagnosis from the later note", merged[0].cad_signs, ["+"]);

const emptyLater = buildPatientRecord(
  p2026,
  [
    visit({
      day: "2026-02-01",
      dx: [
        dx("type 2 dm"),
        dx("dual adiposity"),
        dx("nephropathy", "", "g3aa2"),
        dx("cad", "absent"),
      ],
    }),
    visit({ day: "2026-06-01", dx: [], cad_signs: ["+"] }),
  ],
  { medsByPatient: new Map(), diagnosisByPatient: new Map(), readingsByPatient: new Map() },
);
check(
  "Later visit with empty diagnosis list does not erase dual adiposity / DKD; its CAD sign still counts",
  [emptyLater.latestListDay, emptyLater.dualDx, emptyLater.dkd, emptyLater.cad],
  ["2026-02-01", true, true, true],
);

const s = summarise([rec]);
check("HbA1c < 7 share", [s.hba1c.n, s.hba1c.of], [1, 1]);
check("All three needs LDL in period", [s.allThree.n, s.allThree.of], [0, 0]);

const mix = summarise([
  { visits: 1, glp1: true, diabetic: true, cad: true, molecules: [] },
  { visits: 1, glp1: false, diabetic: true, cad: false, molecules: [] },
  { visits: 1, glp1: true, diabetic: false, cad: null, molecules: [] },
  { visits: 1, glp1: false, diabetic: false, cad: true, molecules: [] },
]);
check("GLP-1 among diabetic patients", [mix.glp1Diabetic.n, mix.glp1Diabetic.of], [1, 2]);
check("GLP-1 among CAD patients", [mix.glp1Cad.n, mix.glp1Cad.of], [1, 2]);

for (const [name, expected] of [
  ["Aweekly", true],
  ["nj aweekly", true],
  ["Awikly", true],
  ["A weekly", true],
  ["Awiqli 70 units", true],
  ["Tresiba", false],
  ["take a weekly walk", false],
]) {
  check(`Awiqli spelling: ${name}`, drugFlags([{ name }]).icodec, expected);
}
for (const [name, expected] of [
  ["Sundae Pro Pen", true],
  ["Obeda", true],
  ["Gliptino", true],
  ["Extensior", true],
  ["Ryzodeg", false],
]) {
  check(`GLP-1 brand: ${name}`, drugFlags([{ name }]).glp1, expected);
}

for (const [text, expected] of [
  ["future plan: bone health liver health advice: plan for wegovy testo, lh", true],
  ["plan for inj mounjaro /inj wegovy", true],
  ["want to wait for glp1 follow up today:30/4/26", true],
  ["patient refused for inj wegovy hba1c-7.4", true],
  ["patient did not start inj wegovy and wants to opt for lifestyle changes", true],
  ["fbg-142 rybelsus stopped follow up today", false],
  ["no gmi no hypoglycaemia no adverse effects from trulicity follow up", false],
  ["c/o nausea vomiting with rybelsus took only 10-12 tablet", false],
  ["exendin scan- diffuse glp1 expression in entire bulky pancreas", false],
  ["advice : usg breast seman analysis follow up", false],
  ["tab glizid m od inj mounjaro 5mg weekly", false],
]) {
  check(`GLP-1 advice: ${text.slice(0, 50)}`, isGlp1Advice(text), expected);
}

const rec2025 = buildPatientRecord(periods[2], visits, ctx);
check(
  "2025: one visit, Mounjaro row from 2024 not counted",
  [rec2025.visits, rec2025.glp1, rec2025.icodec],
  [1, false, true],
);
check("2025: dual adiposity on latest 2025 list", rec2025.dualDx, true);

console.log(`\nopd-yoy checks: ${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
