// The spoken-vitals parser. Pure function, no database — it decides what number
// a doctor may later act on, so every phrasing the floor is likely to use has a
// case here, as does every mishearing that must NOT become a reading.
//
//   npm run smoke:giniflow-speech
import { parseSpokenVitals } from "../../shared/giniflowVitalsSpeech.js";

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

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
