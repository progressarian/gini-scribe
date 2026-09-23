# OPD billing sheet → Scribe upload (2026-09-23)

The admin team's `docs/OPD Billing example.xlsx` (466 rows) was converted into the Scribe bulk-import template: **`docs/gini-billing-upload-from-admin.xlsx`**. Scribe's own preview reads it as **476 new rows, no errors**.

## What the upload creates

| Group         | Subgroup              | Items |
| ------------- | --------------------- | ----- |
| OPD           | OPD services          | 36    |
| Pathology     | Pathology tests       | 279   |
| Radiology     | Radiology and imaging | 145   |
| Machine tests | Machine room tests    | 6     |
| ECHO          | Echocardiography      | 1     |

- **Machine tests** were pulled out of OPD and Radiology to match the floor's stations: ABI, VPT, Fundus, ECG, TMT and the ABI/VPT/FUNDUS package. **2D Echo** has its own ECHO group. Dopplers, DEXA and the 92 X-ray views stayed in Radiology, because they are imaging.
- **31 of the 32 lab catalogue tests are linked** (all but the duplicate Vit D), so an ordered test knows its price. The 19 that were missing from the sheet (CBC, TSH, Lipid panel, Vitamin D…) were added with the catalogue's own price.
- **TMT is one item at ₹1,900**, as decided. The ₹1,600 row was dropped.
- Item codes were generated (OPD-001, LAB-001, RAD-001, MAC-001, ECHO-001…). Names and prices are otherwise exactly as sent.

## Rows left out (19)

**Not a real service (6):**

- add — ₹500 (OPD)
- DOCTOR CONSULTATION — ₹1500 (OPD)
- DOCTOR CONSULTATION( — ₹1500 (OPD)
- DOCTOR CONSULTATION(= — ₹1500 (OPD)
- Online — ₹1500 (OPD)
- PT — ₹280 (PATHOLOGY)

**The same name twice in one group (12, the first was kept):**

- Ceruloplasmin — ₹990 (PATHOLOGY)
- DIETICIAN CONSULTAION — ₹1500 (OPD)
- New Appointment — ₹1500 (OPD)
- PROCALCITONIN — ₹2500 (PATHOLOGY)
- Protein Total — ₹100 (PATHOLOGY)
- RA FACTOR — ₹320 (PATHOLOGY)
- Triglycerides (Tg) Serum — ₹200 (PATHOLOGY)
- WIDAL — ₹170 (PATHOLOGY)
- X-RAY L-S SPINE AP — ₹300 (RADIOLOGY)
- X-RAY L-S SPINE AP/LAT — ₹300 (RADIOLOGY)
- X-RAY L-S SPINE LAT — ₹300 (RADIOLOGY)
- X-RAY L/S SPINE LAT — ₹300 (RADIOLOGY)

**The second TMT price:** TMT ₹1,600 (Radiology), dropped in favour of ₹1,900.

## For the admin team to look at

**1. Consultations (32 rows) are uploaded as fixed-price items,** as decided. In Scribe a consultation is normally an item per doctor and visit type, priced per category on the **Consultant fees** screen, which is what makes the CGHS and Pensioner fees work. Worth rebuilding there later:

- DIETICIAN CONSULTAION
- CONSULTATION (DR. RAHUL KATYAL)
- DIETICIAN CONSULTAION(MONTLY PKG)
- Dietician Consultation
- DIETITION CONSULTATION
- DIETITION CONSULTATION(Dt. neetika)
- DIETITION CONSULTATION(Dt. Rashi)
- DOCTOR CONSULTATION (Dr. Iqbal)
- DOCTOR CONSULTATION (dr. jatin)
- DOCTOR CONSULTATION (DR. MALIKA JINDAL)
- DOCTOR CONSULTATION (Dr. mehak)
- DOCTOR CONSULTATION (dr. navjot)
- DOCTOR CONSULTATION (DR. NEHA)
- DOCTOR CONSULTATION (DR. NITIN)
- DOCTOR CONSULTATION (DR.HARJOBAN SINGH)
- DOCTOR CONSULTATION (Follow Up)
- DOCTOR CONSULTATION (New)
- doctor consultation (rashi )
- DOCTOR CONSULTATION(dr. abhinav )
- DOCTOR CONSULTATION(Dr. Dhankhar)
- DOCTOR CONSULTATION(Dr. navneet Kaur)
- DOCTOR CONSULTATION(Dr. Rashi)
- DOCTOR CONSULTATION(Dr. Renu)
- DOCTOR CONSULTATION(Dt. Rashi)
- DR. JASDEEP SINGH (PHYSIOTHERAPIST)
- DR. SATINDER
- Dr.Bhansali Additional Fees.
- follow up appointment -
- follow up appointment - Dr. beant Kaur
- MEDICAL OFFICER
- New Appointment
- TRIAGE

**2. The test catalogue lists Vit D (₹900) and Vitamin D (₹1,200) separately, both active.** Only **Vitamin D ₹1,200** is in this upload; Vit D was dropped. **Please retire "Vit D" on the test catalogue page**, otherwise a lab order for it has no priced item behind it.

**3. Catalogue prices differ from the sheet for tests the hospital already prices.** The sheet wins in this upload: ABI ₹300 (catalogue ₹500), ECG ₹200 (₹300), Fundus ₹500 (₹500), VPT ₹300 (₹500), TMT ₹1,900 (₹500), 2D Echo ₹2,200 (₹2,200). The catalogue price was used only for the 20 tests the sheet didn't have.

**4. One warning, accepted:** the catalogue's generic X-Ray sits in Radiology with the other X-ray views, so its revenue counts under Radiology rather than Machine tests.

**5. Emergency prices.** ERYTHROPOIETIN (EPO )SERUM (emergency ₹2925); JAK 2,GENE MUTATION, PCR QUALITATIVE (emergency ₹5710). Scribe has one price per item, so an emergency price is not carried over.

**6. Tax.** The sheet's HSN and TAX columns are empty, so every item is uploaded with no tax code. That is right while GST is off.
