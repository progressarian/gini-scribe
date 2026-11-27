# Test steps: Rx-MO single station, medicine order, stock column removed

Migration `server/migrations/2026-11-27_giniflow_rx_order_manual.sql` is applied on production (2026-11-27).
The code changes must be deployed (API + `npm run build`) before these steps work on scribe.ginihealth.com.

## 1. One station for an MO who works for a chief

| # | Log in as | Open | Expected |
|---|-----------|------|----------|
| 1.1 | Dr. Supreet (MO, works for Dr. Anil Bhansali) | `/giniflow/stations` | Only **Chief Endocrinologist · Dr. Anil Bhansali** tile. No "Prescriptions · other consultants" tile. |
| 1.2 | Same | Click the tile | Opens `/giniflow/station/mo` with Dr. Bhansali's assigned patients, as before. |
| 1.3 | An MO who works for a **non-chief** consultant (if one exists) | `/giniflow/stations` | Still sees the **Prescriptions** tile. |
| 1.4 | Consultant / admin | `/giniflow/stations` | Tiles unchanged. |

## 2. Pharmacy stock column removed

| # | Where | Expected |
|---|-------|----------|
| 2.1 | Consultant station → open a patient → Prescription | Columns: **# · Medicine · Dose · Timing · For · Actions**. No "Pharmacy stock", no "Alternatives →". |
| 2.2 | Same, MO station (Dr. Supreet) | Same columns, headings line up with the rows. |
| 2.3 | Edit / Pause / Stop on a row | Still work. |
| 2.4 | Narrow the window below ~980px | Rows stack cleanly, no empty stock line. |
| 2.5 | Pharmacy station and Pharmacy → Stock page | Unchanged — stock still shown there. |

## 3. Settings → Medicine order (admin, consultants, MOs, prescription MOs)

The order is **shared** — one order for the whole hospital. Any doctor who saves changes it for everyone; every save is recorded in the audit log with who made it.

| # | Step | Expected |
|---|------|----------|
| 3.1 | Admin → Settings | New tab **Medicine order** after "Prescription". |
| 3.1a | Consultant (e.g. Dr. Bhansali), MO, and Dr. Supreet → sidebar **Settings** | Opens straight on **Medicine order**; it is the only settings tab they see. They can edit and save. |
| 3.1b | Dr. Bhansali → Pinned medicines → search `glyc` | Search results appear (works even though his patients are handled by his prescription MO). |
| 3.2 | Log in as reception/nurse, open `/settings/medicine-order` | No access (no Settings link, page blocked; API answers 403). |
| 3.3 | Open the tab | Category order: Diabetes, Cardiac, Lipids, Kidney, BP, Thyroid, Urology, Other, Supplements. Diabetes classes: Insulin, Metformin, SGLT2, GLP-1, DPP-4, Sulphonylurea, Pioglitazone, Acarbose. No pins. |
| 3.4 | Clear a category name → | Red "Enter a category name." under the field; **Save order** disabled. |
| 3.5 | In Thyroid keywords add `, euthyrox` → Save order | Toast "Medicine order saved…". Reload — keyword still there. |
| 3.6 | Move "Supplements" up with ▲ → Save | Order saved. (Move it back afterwards.) |
| 3.7 | Pinned medicines → search `aktiv` → pick AKTIV D → Category "Supplements", position 1 → Save | Pin listed in the table. |
| 3.8 | Change something, then **Discard changes** | Form returns to the saved values. |
| 3.9 | **Restore built-in order** → confirm dialog → Restore | Back to defaults (your keyword/pin removed). Re-add what you want to keep. |

## 4. Order on the prescription

Use a patient whose draft has **not** been started yet today.

| # | Step | Expected |
|---|------|----------|
| 4.1 | Open the patient on the consultant or MO station so the draft is seeded | Medicines in standard order: diabetes first (insulin → metformin → SGLT2 …), then cardiac, lipids, kidney, BP, thyroid, other, supplements last. Stopped medicines at the bottom. |
| 4.2 | **+ Add medicine** (e.g. a metformin brand) | It lands with the other diabetes medicines, not at the bottom. |
| 4.3 | Press ▼ on medicine #1 | It moves to #2. Header shows **Custom order**. Reload — order kept. |
| 4.4 | Add another medicine while in Custom order | It goes to the end. |
| 4.5 | Press **↺ Standard order** | Toast "Medicines put back in the standard order"; list re-sorted; "Custom order" badge gone. |
| 4.6 | ▲ on the first row / ▼ on the last row | Disabled. |
| 4.7 | A patient whose draft was opened **before** deploying | Old order stays until you press **↺ Standard order** — then it sorts. |
| 4.8 | Settings change (3.6/3.7), then a **new** patient's draft | New draft follows the new settings. |
| 4.9 | MO station, patient not in edit mode (read-only) | No ▲▼ and no Standard order button. |
| 4.10 | Finalized patient → Edit prescription | Re-opened draft is in standard order. |

### 3b. Tabs on the Medicine order page

| # | Step | Expected |
|---|------|----------|
| 3b.1 | Open Settings → Medicine order | Three tabs: **Categories · Drug classes · Pinned medicines**; Categories open first. |
| 3b.2 | Click a tab, reload | Same tab stays open (`?tab=` in the URL). Left/Right arrow keys move between tabs. |
| 3b.3 | Clear a category name, switch to another tab | Categories tab shows a red “1 to fix”; Save order stays disabled. |
| 3b.4 | Edit in two tabs, then Save order | One save keeps changes from all tabs. |

## 4b. Admin: view another SD's patient (MO station)

| # | Step | Expected |
|---|------|----------|
| 4b.1 | Admin → `/giniflow/station/mo` → group **With another SD** | Rows are clickable and marked **View only**. |
| 4b.2 | Click one | Patient opens with “👁 View only — this is Dr X's patient…”. Vitals, labs, plan, prescription are visible. |
| 4b.3 | Try to type in the plan, order a test, edit/move a medicine | All fields and buttons are disabled; no “Not my patient”, “Edit prescription”, “Ready for the doctor” or “Close” buttons; no tests-due popup. |
| 4b.4 | Check the other SD's screen | Patient is still theirs — opening did not claim or move them. |
| 4b.5 | Log in as an MO (not admin) | “With another SD” rows stay greyed out and cannot be opened. |

## 5. Not changed (known)

- The **printed prescription PDF** still groups by the old built-in categories; it does not follow Settings → Medicine order yet.

## 6. Developer checks (local, never production)

```bash
node scripts/check-repo-safety.mjs HEAD      # before any npm/vite command
npm run build
npm run check:giniflow                       # 3 pre-existing FAILs (FlowManager, MachineStation, TriageBoard) are not from this change
npm run test:e2e:setup                       # rebuild local test DB with the new migration
```
