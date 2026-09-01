// The spoken-vitals parser. Pure function, no database — it decides what number
// a doctor may later act on, so every phrasing the floor is likely to use has a
// case here, as does every mishearing that must NOT become a reading.
//
//   npm run smoke:giniflow-speech
import { parseSpokenVitals, flagLargeChanges } from "../../shared/giniflowVitalsSpeech.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const parse = (t) => parseSpokenVitals(t).values;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check(
  "the example from the screen parses whole",
  same(parse("Weight 72 kilos, BP 148 over 94, pulse 82, SpO2 98"), {
    bpSys: 148,
    bpDia: 94,
    weight: 72,
    pulse: 82,
    spo2: 98,
  }),
);
check(
  "every field in one sentence",
  Object.keys(parse("weight 72, bp 148 over 94, pulse 82, spo2 98, temperature 98.6, height 161"))
    .length === 7,
);
check("'by' as a BP separator", same(parse("blood pressure 148 by 94"), { bpSys: 148, bpDia: 94 }));
check("slash as a BP separator", same(parse("BP 148/94"), { bpSys: 148, bpDia: 94 }));
check("'point' becomes a decimal", same(parse("temperature 98 point 6"), { temp: 98.6 }));
check("decimal weight", same(parse("weight 72.4 kg"), { weight: 72.4 }));
check("units are ignored", same(parse("pulse 82 bpm, spo2 98 percent"), { pulse: 82, spo2: 98 }));
check("synonyms: heart rate", same(parse("heart rate 76"), { pulse: 76 }));
check("synonyms: oxygen saturation", same(parse("oxygen saturation 97"), { spo2: 97 }));

// The dangerous cases: a number must never land in the wrong field.
check(
  "a following field does not steal the previous number",
  same(parse("pulse 82, spo2 98"), { pulse: 82, spo2: 98 }),
);
check("spo2 is not read as a bare oxygen number", parse("pulse 82 spo2 98").pulse === 82);
check(
  "an out-of-range value is rejected, not stored",
  Object.keys(parse("BP 1480 over 94")).length === 0,
);
check("a rejected value is reported", parseSpokenVitals("weight 900 kilos").rejected.length === 1);
check(
  "words instead of digits fill nothing",
  Object.keys(parse("weight seventy two")).length === 0,
);
check("silence fills nothing", Object.keys(parse("")).length === 0);
check(
  "unrelated speech fills nothing",
  Object.keys(parse("the patient seems fine today")).length === 0,
);
check(
  "the transcript is returned for review",
  parseSpokenVitals("pulse 82").transcript === "pulse 82",
);

// ── Systolic and diastolic said separately ──────────────────────────────────
// How a nurse reading a monitor actually speaks, and the phrasing that shipped
// broken: "weight 80 systolic blood pressure 179 diastolic 79" filled only weight.
check(
  "the reported transcript now parses whole",
  same(parse("weight 80 systolic blood pressure 179 diastolic 79"), {
    bpSys: 179,
    bpDia: 79,
    weight: 80,
  }),
);
check(
  "bare systolic/diastolic",
  same(parse("systolic 179 diastolic 79"), { bpSys: 179, bpDia: 79 }),
);
check("upper and lower as synonyms", same(parse("upper 148 lower 94"), { bpSys: 148, bpDia: 94 }));
check("a bare pair reads as BP", same(parse("148 by 94"), { bpSys: 148, bpDia: 94 }));
check(
  "a reversed bare pair is not read as BP",
  Object.keys(parse("94 by 148")).length === 0,
  "diastolic cannot exceed systolic",
);
check(
  "everything in one breath",
  Object.keys(parse("weight 80 systolic 179 diastolic 79 pulse 88 spo2 97 temperature 98.4"))
    .length === 6,
);

// ── What was NOT heard has to be nameable ───────────────────────────────────
const partial = parseSpokenVitals("weight 80 systolic 179 diastolic 79");
check(
  "missing fields are reported",
  partial.missing.includes("pulse") && partial.missing.includes("spo2"),
);
check("heard fields are not reported missing", !partial.missing.includes("weight"));

// ── Large change against the last visit ─────────────────────────────────────
const LAST = { bp_sys: 126, bp_dia: 78, weight: 77.2, pulse: 80, spo2: 98, temp: 98.4 };
const flagged = flagLargeChanges({ bpSys: 179, bpDia: 79 }, LAST);
check("179/79 against 126/78 is flagged", flagged.length === 1 && flagged[0].label === "BP");
check(
  "a small BP change is not flagged",
  flagLargeChanges({ bpSys: 132, bpDia: 80 }, LAST).length === 0,
);
check(
  "BP is flagged once, not twice",
  flagLargeChanges({ bpSys: 179, bpDia: 110 }, LAST).length === 1,
);
check("a big weight change is flagged", flagLargeChanges({ weight: 82 }, LAST).length === 1);
check("a fall in SpO2 is flagged", flagLargeChanges({ spo2: 92 }, LAST).length === 1);
check("a rise in SpO2 is not", flagLargeChanges({ spo2: 100 }, LAST).length === 0);
check(
  "nothing is flagged without a last visit",
  flagLargeChanges({ bpSys: 179 }, null).length === 0,
);
check("nothing is flagged for an empty form", flagLargeChanges({ bpSys: null }, LAST).length === 0);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
