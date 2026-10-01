import "../loadEnv.js";
import pool from "../config/db.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";

const APPLY = process.argv.includes("--apply");

const PAIRS = [
  ["Potassium, Serum", "LAB-POTASSIUM"],
  ["Cortisol [Morning]", "LAB-CORTISOL"],
  ["DHEA Sulphate", "LAB-DHEAS"],
  ["RFT (Renal Function Test)", "LAB-RFT"],
  ["GAD IAA IA2", "LAB-GAD-65-IAA-IA2"],
  ["Leutinizing Hormone", "LAB-LH"],
  ["Total P1NP", "LAB-P1NP"],
  ["Prostate Specific Antigen (Total) PSA", "LAB-PROSTATE-SPECIFIC-ANTIGEN-PSA-TOTAL"],
  ["FREE PSA", "LAB-PROSTATE-SPECIFIC-ANTIGEN-PSA-FREE"],
  ["Alkaline Phosphatase (ALP), Serum", "LAB-ALKALINE-PHOSPHATASE-ALP"],
  ["POST PRANDIAL BLOOD SUGAR", "LAB-GLUCOSE-POST-PRANDIAL-PP"],
  ["FINVASIA PACKAGE", "LAB-FINV-PACKAGE-BLOOD"],
  ["ERYTHROCYTES SEDIMENTATION  RATE", "LAB-ESR"],
  ["S. Lipase", "LAB-LIPASE"],
  ["Free Thyroxine (FT4)", "LAB-THYROXINE-FREE-FT4"],
  ["Free Triiodothyronine (FT3)", "LAB-TRIIODOTHYRONINE-FREE-FT3"],
  ["Cortisol [Evening]", "LAB-CORTISOL-SERUM-EVENING"],
  ["IMMUNOGLOBULIN IgE, SERUM", "LAB-TOTAL-IGE-SERUM"],
  ["ANTI CCP", "LAB-ANTI-CYCLIC-CITRULLINATED-PEPTIDE-AN"],
  ["Cholestrol", "LAB-CHOLESTEROL"],
  ["PROTEIN ELCETROPHOISIS", "LAB-PROTEIN-ELECTROPHORESIS-SERUM"],
  ["ANTI NUCLEAR ANTIBODY IFA", "LAB-ANTI-NUCLEAR-ANTIBODY-ANA"],
  ["MALARIA ANTIGEN TEST (Pv/Pf)", "LAB-MALARIA"],
  ["LDH (Lactate Dehydrogenase)", "LAB-LDH-LACTATE-DEHYDROGENASE-SERUM"],
  ["Alpha pheto Protein(AFP)", "LAB-ALPHA-FETO-PROTEIN-AFP-SERUM"],
  ["SPUTAM CULTURE", "LAB-CULTURE-AEROBIC-SPUTUM"],
  ["Blood culture aerobic trust diagno", "LAB-BLOOD-CULTURE-AEROBIC"],
  ["Biopsy -Large - 1", "LAB-BIOPSY-LARGE-SPECIMEN"],
  ["PLATELETS COUNT", "LAB-PLATELET-COUNT"],
  ["STOOL EXAMINATION: OCCULT BLOOD", "LAB-STOOL-OCCULT-BLOOD"],
];

let linked = 0;
let skipped = 0;
for (const [alias, code] of PAIRS) {
  const { rows } = await pool.query(
    `SELECT id, name, base_price FROM service_items
      WHERE is_active AND kind = 'test' AND upper(code) = upper($1)`,
    [code],
  );
  if (rows.length !== 1) {
    console.log("SKIPPED", alias, "— found", rows.length, "active test items with code", code);
    skipped += 1;
    continue;
  }
  const [item] = rows;
  if (!APPLY) {
    console.log("[dry]", alias, "→", code, `"${item.name}" ₹${item.base_price}`);
    linked += 1;
    continue;
  }
  try {
    await addAlias(item.id, { name: alias }, {});
    console.log("linked", alias, "→", code, `"${item.name}" ₹${item.base_price}`);
    linked += 1;
  } catch (error) {
    console.log("SKIPPED", alias, "—", error.message);
    skipped += 1;
  }
}
console.log(
  APPLY ? "APPLIED" : "DRY RUN — rerun with --apply",
  `· ${linked} linked · ${skipped} skipped`,
);
await pool.end();
