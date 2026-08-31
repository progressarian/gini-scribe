// ============================================================================
// Turning a spoken sentence into vitals fields.
//
// Deliberately a deterministic parser, not an LLM call. These are clinical
// numbers a doctor may act on: a parser either recognises "BP 148 over 94" or it
// does not, and the nurse sees exactly which fields it filled. A model that
// silently rounds 148 to 150, or infers a pulse nobody said, would be worse than
// no voice entry at all.
//
// It never saves. It fills the form; the nurse reads it back and presses Done.
// ============================================================================

// Spoken forms per field, longest first so "blood pressure" wins over "pressure"
// and "spo2" is not eaten by a bare "o2".
const FIELDS = [
  {
    key: "bp",
    words: ["blood pressure", "bp", "pressure"],
    // "148 over 94", "148 by 94", "148/94", "148 - 94"
    pattern: /(\d{2,3})\s*(?:over|by|slash|\/|-)\s*(\d{2,3})/i,
    pair: true,
  },
  { key: "weight", words: ["weight", "wait", "vajan"], pattern: /(\d{1,3}(?:[.,]\d)?)/ },
  { key: "height", words: ["height", "heights"], pattern: /(\d{2,3}(?:[.,]\d)?)/ },
  { key: "pulse", words: ["pulse", "heart rate", "heartrate"], pattern: /(\d{2,3})/ },
  {
    key: "spo2",
    words: ["spo2", "sp o2", "spo 2", "oxygen saturation", "saturation", "oxygen", "sats"],
    pattern: /(\d{2,3})/,
  },
  { key: "temp", words: ["temperature", "temp", "fever"], pattern: /(\d{2,3}(?:[.,]\d)?)/ },
];

// The same bounds the form and the API enforce. A misheard number is common —
// "ninety eight" becoming 9808 — and a value outside these is a mishearing, not
// a reading, so it is reported as unrecognised rather than filled in.
const BOUNDS = {
  weight: [1, 400],
  height: [30, 260],
  bpSys: [50, 300],
  bpDia: [20, 200],
  pulse: [20, 250],
  spo2: [50, 100],
  temp: [90, 115],
};

const inBounds = (field, value) =>
  value !== null && value >= BOUNDS[field][0] && value <= BOUNDS[field][1];

const toNumber = (raw) => {
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

// "point six" and "decimal six" are how a dictation engine often renders 98.6.
const normalise = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/\s+point\s+(\d)/g, ".$1")
    .replace(/\s+decimal\s+(\d)/g, ".$1")
    .replace(/\bkilos?\b|\bkgs?\b|\bkilograms?\b/g, " ")
    .replace(/\bcentimetres?\b|\bcentimeters?\b|\bcms?\b/g, " ")
    .replace(/\bpercent\b|%/g, " ")
    .replace(/\bbeats per minute\b|\bbpm\b/g, " ")
    .replace(/\bdegrees?\b|\bfahrenheit\b|\bf\b/g, " ")
    .replace(/\bmmhg\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function parseSpokenVitals(transcript) {
  const text = normalise(transcript);
  const values = {};
  const filled = [];
  const rejected = [];

  if (!text) return { values, filled, rejected, transcript: "" };

  for (const field of FIELDS) {
    for (const word of field.words) {
      const at = text.indexOf(word);
      if (at === -1) continue;

      // Only look at what follows the keyword, and stop before the next field's
      // keyword so "pulse 82, spo2 98" cannot read 98 as the pulse.
      const after = text.slice(at + word.length);
      const nextKeyword = FIELDS.flatMap((f) => (f === field ? [] : f.words))
        .map((w) => after.indexOf(w))
        .filter((i) => i > 0)
        .sort((a, b) => a - b)[0];
      const window = nextKeyword === undefined ? after : after.slice(0, nextKeyword);

      const m = window.match(field.pattern);
      if (!m) break;

      if (field.pair) {
        const sys = toNumber(m[1]);
        const dia = toNumber(m[2]);
        if (inBounds("bpSys", sys) && inBounds("bpDia", dia)) {
          values.bpSys = sys;
          values.bpDia = dia;
          filled.push("bpSys", "bpDia");
        } else {
          rejected.push({ field: "bp", heard: `${m[1]}/${m[2]}` });
        }
      } else {
        const v = toNumber(m[1]);
        if (inBounds(field.key, v)) {
          values[field.key] = v;
          filled.push(field.key);
        } else {
          rejected.push({ field: field.key, heard: m[1] });
        }
      }
      break;
    }
  }

  return { values, filled, rejected, transcript: String(transcript || "").trim() };
}

export const SPOKEN_EXAMPLE = "Weight 72 kilos, BP 148 over 94, pulse 82, SpO2 98";
