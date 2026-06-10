# 04 — Rollout, RBAC, Testing

## A. Phases

**Phase 0 — decisions + RBAC capability (NEW)**
- Confirm the 5 open decisions in Doc 00 §5.
- ⚠️ **`CAPABILITIES.PHARMACY` does not exist yet** — only `ROLES.PHARMACY`
  (which currently maps to `[PATIENT_READ, REFILLS, DOSE_REVIEWS]`). Add a new
  capability in `shared/permissions.js`, e.g.:
  ```js
  // CAPABILITIES
  MED_COLLECTION: "MED_COLLECTION", // pharmacy: mark medicine collection
  // ROLE_CAPABILITIES
  [ROLES.PHARMACY]: [C.PATIENT_READ, C.REFILLS, C.DOSE_REVIEWS, C.MED_COLLECTION],
  [ROLES.RECEPTION]: [..., C.MED_COLLECTION],   // optional, if reception also marks
  ```
  Add the page→capability entry in `src/config/routes.js`, a
  `requireCapability(MED_COLLECTION)` guard for writes, and a Pharmacy nav entry.

**Phase 1 — Data + write path (Module core)**
- Migration `medicine_collections` (Doc 01) — one table, additive, idempotent.
- `server/routes/medicineCollection.js`: the `today`, patient-meds, mark, and
  bulk endpoints (Doc 02) + Zod schemas.
- Mount in `server/index.js`; smoke-test script.

**Phase 2 — Pharmacy worklist UI**
- "Medicine Collection" page: today's patients + search → patient med table →
  3-way mark + reason + bulk save (Doc 02).
- Gated on `PHARMACY`.

**Phase 3 — Report + history**
- Report endpoints + view (Doc 03); patient-page "Pharmacy collection" panel;
  "Not collected" follow-up sub-tab.

**Phase 4 — Journey integration ✅ DONE**
- Pharmacy collection now stamps the patient-journey board's **Rx station**
  (`station_tracking`, keyed by `appointment_id`):
  - first mark of the day → `rx_checkin` (COALESCE — set once);
  - once every current med is resolved (no pending lines) → `rx_checkout`;
  - `rx_explained_by` = who marked.
- Best-effort: only an **existing** journey row is updated (patients not on
  today's board are never added); a stamp failure is caught and never blocks the
  collection save. The mark/bulk responses include a `journey` field
  (`stamped` | `in_progress` | `no_journey` | `no_appt`), and the worklist toast
  says "journey Rx station marked done" when complete.
- Helper: `stampRxJourney()` in `server/routes/medicineCollection.js`; covered by
  smoke section 4.

Each phase is independently shippable. Phase 1+2 is the minimum useful product
(pharmacy can record; data exists); Phase 3 adds the doctor/management visibility.

## B. RBAC summary
| Action | Capability |
|--------|-----------|
| Mark collection (worklist) | `MED_COLLECTION` (new — write) |
| View worklist / patient meds | `MED_COLLECTION` / `RECEPTION_OPS` |
| View report + patient history | `ANALYTICS` (doctors/mgmt) + `MED_COLLECTION` |

`MED_COLLECTION` is a **new** capability to add (see Phase 0).
`GRANT_ALL_CAPABILITIES` is currently TRUE → guards are permissive until the
matrix is enabled (same as doctor-management endpoints). Declare them now.

## C. Migrations checklist (additive, dated, idempotent)
1. `medicine_collections` (+ indexes, unique) — Phase 1
2. *(optional)* `v_patient_collection_day` view — Phase 3
3. No changes to `medications` are required.

Rollback = `DROP TABLE medicine_collections` (+ view). Nothing existing is
altered. A flag (`MED_COLLECTION_MODULE=off`) can hide the nav until ready.

## D. Testing (smoke + flow)
- **Smoke** (`npm run smoke:med-collection`): table exists; mark a real
  patient's med given/not_given/partial (rolled back); roll-up counts correct;
  not_given-without-reason rejected.
- **Flow:** prescribe → patient appears in today's worklist → mark all given →
  report shows "all collected" → next visit, mark one not_given → report shows
  "partial" and history has two dated rows.
- **Edge:** patient with no current meds not in worklist; re-mark same day
  updates in place; bulk "mark all given" writes one row per current med.

## E. Effort shape
- **Phase 1 (data + API):** small — 1 table, ~5 endpoints, schemas.
- **Phase 2 (worklist UI):** medium — the main screen, 3-way marking, bulk save.
- **Phase 3 (report + history):** medium — report view + patient panel.

Recommend shipping **Phase 1 + 2 together** (pharmacy can start recording
immediately), then Phase 3 for management visibility.

## F. What changed vs the first draft
The earlier docs scoped *stock/inventory*, *brand-catalog*, and *adherence
analytics*. Per the clarified ask this is narrowed to **collection tracking**:
record per-medicine given/not-given at the pharmacy → report it → keep history.
Inventory/brand/adherence are deferred (Doc 00 §6).
