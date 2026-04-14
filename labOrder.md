# Lab / Report Order — Canonical Reference

This document defines the **single canonical order** for lab tests, biomarker
panels and investigation packages across the gini-scribe app.

The order mirrors the medication and diagnosis grouping used elsewhere in the
app (`server/utils/medicationSort.js`, `server/utils/diagnosisSort.js`) so a
clinician scanning the patient record sees labs, diagnoses and meds for the
same body system sitting visually adjacent:

| Lab Section                 | Diagnosis Group        | Medication Group     |
|-----------------------------|------------------------|----------------------|
| Diabetes & Glycaemic Control| Primary (DM)           | Diabetes             |
| Renal Function (RFT + UACR) | Diabetic Nephropathy   | Kidney (ACE / ARB)   |
| Lipid Profile               | Dyslipidemia           | Lipids (Statins)     |
| Liver Function (LFT)        | NAFLD / MASLD          | (covered by lifestyle) |
| Thyroid                     | Hypothyroidism         | Thyroid (Levothyroxine) |
| Cardiac / Inflammation      | CAD                    | Cardiovascular       |
| CBC                         | Anaemia                | (covered by supplements)|
| Vitamins & Minerals         | Vit D / B12 deficiency | Supplements          |

---

## Canonical Order

### 1. Diabetes & Glycaemic Control
**Why first:** Primary disease in this clinic; every patient encounter starts here.
- HbA1c
- Fasting Blood Sugar (FBS / FBG)
- Post-Prandial Blood Sugar (PPBS / PPBG / PPG)
- Fasting Insulin
- C-Peptide
- HOMA-IR (calculated or measured)

### 2. Renal Function (RFT + UACR)
**Why second:** Nephropathy is the most prevalent diabetic complication and
gates med choices (Metformin contraindicated when eGFR drops, SGLT2i preferred
when UACR rises).
- **RFT panel:** Creatinine → eGFR → Urea / BUN → Uric Acid → Electrolytes (Na⁺, K⁺, Cl⁻, HCO₃⁻)
- **Microalbumin / UACR:** spot urine Albumin:Creatinine ratio

### 3. Lipid Profile
**Why third:** Cardiovascular risk is the #1 cause of mortality in DM2.
- Total Cholesterol
- LDL Cholesterol
- HDL Cholesterol
- Triglycerides
- Non-HDL
- VLDL
- Ratios (LDL/HDL, Total/HDL)

### 4. Liver Function (LFT)
**Why fourth:** MASLD/NAFLD is highly prevalent in DM2 (50–70%); SGPT/SGOT
trends drive metabolic-liver decisions.
- SGPT / ALT
- SGOT / AST
- ALP (Alkaline Phosphatase)
- GGT
- Bilirubin (Total + Direct)
- Albumin
- Total Protein

### 5. Thyroid
**Why fifth:** Common DM2 comorbidity (especially in women); affects glycaemic
control and weight.
- TSH
- Free T3
- Free T4
- Anti-TPO

### 6. Cardiac / Inflammation
**Why sixth:** Inflammatory and cardiac stress markers; ordered when CV risk
flagged.
- hs-CRP
- NT-proBNP
- BNP

### 7. Complete Blood Count (CBC)
**Why seventh:** Anaemia screening (esp. Metformin-induced B12 deficiency,
CKD-anaemia, GI losses).
- Haemoglobin
- Hematocrit
- RBC, MCV, MCH, MCHC
- WBC + differentials (Neut / Lymph / Eos / Baso / Mono)
- Platelets

### 8. Vitamins & Minerals
**Why eighth:** Supplementation workup — Vit D & B12 are routine, others
condition-specific.
- Vitamin D (25-OH)
- Vitamin B12
- Folate
- Iron / Ferritin / TIBC / Transferrin
- Calcium
- Phosphate
- PTH
- Magnesium

### 9. Urine / Other
- Urine Routine & Microscopy
- Hb Electrophoresis

### 10. Imaging & Screening
**Note:** Not bloodwork — these are physical exams / device tests; usually
ordered as separate appointments.
- Fundus exam
- ABI (Ankle-Brachial Index)
- VPT (Vibration Perception Threshold)
- ECG
- Echocardiography
- USG Abdomen
- Doppler
- DEXA (Bone Density)
- NCS / EMG

---

## Where this order is enforced

| File                                                | Constant                | Purpose                              |
|-----------------------------------------------------|-------------------------|--------------------------------------|
| `src/config/labOrder.js`                            | `LAB_PANELS`            | Canonical panel definitions (source) |
| `src/config/labOrder.js`                            | `LAB_ORDER_CHIPS`       | Flat chip list for order picker      |
| `src/config/labOrder.js`                            | `KEY_BIOMARKERS`        | Sidebar / dashboard headline list    |
| `src/config/labOrder.js`                            | `LAB_PACKAGES`          | Quick-pick packages on Assess page   |
| `src/components/visit/VisitLabsPanel.jsx`           | imports `LAB_PANELS`    | "Latest Test Results" sections       |
| `src/components/visit/VisitBiomarkers.jsx`          | hardcoded JSX subsections | Biomarker cards order                |
| `src/components/visit/VisitSidebar.jsx`             | local `KEY_BIOMARKERS`  | Quick biomarker readouts             |
| `src/pages/AssessPage.jsx`                          | imports `LAB_PACKAGES`  | "📦" package buttons                 |
| `src/pages/OutcomesPage.jsx`                        | inline `renderSection`  | Biomarker chart sections             |
| `src/config/chips.js`                               | re-exports `LAB_ORDER_CHIPS` | Backward-compat                  |
| `server/routes/outcomes.js`                         | `Promise.all` array     | Biomarker fetch order in API         |
| `server/routes/dashboard.js`                        | `BIOMARKERS` object     | Cohort biomarker stats               |

---

## Rule for Future Changes

> If you add a new lab test, panel or package anywhere in the app, update
> `src/config/labOrder.js` **and** this `labOrder.md` together in the same
> commit. The clinical order documented here is the contract — every consumer
> file derives from it.
