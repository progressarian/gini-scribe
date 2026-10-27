# CRM doctors — add, edit, delete with approval, and log visits from the form

Status: **plan, not built** (2026-10-27). Decisions in §11.

## 1. Goal

Field staff (Rajesh Sharma, Sandeep Sangroy) and their admins can keep the doctor list right from
inside the CRM, without an Excel import:

1. **Add a doctor.** A rep who adds a doctor owns it straight away — no "Tagging"/Assigned to
   needed. An admin who adds one picks who it goes to (or leaves it unassigned).
2. **Edit a doctor.** Address, mobile, WhatsApp, area, specialty, clinic, etc. Saved directly,
   with a history of who changed what.
3. **Delete a doctor.** A rep can only **request** it, with a reason. It is removed only when an
   admin approves. Admins can delete directly, still with a reason.
4. **Log a visit from the form** at the time of the visit — the same statuses the sheet uses
   (Completed, Doctor unavailable), so the form and the sheet are two ways into one record.

"Admin" in this plan = `ceo_admin` and `head_of_growth` (Virender Satija) — the existing
`ASSIGNING_ROLES`. "Rep" = `growth_executive` and `growth_manager`.

## 2. What exists today (from the code)

| Piece                  | Where                                                        | State                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Doctor record          | `crm.doctors`                                                | Has every field we need (name, specialty, qualifications, clinic, address, area, city, PIN, territory, mobile, WhatsApp, alt mobile, clinic phone, email, priority, notes). Soft delete via `deleted_at`; hard deletes blocked by trigger. |
| Mobile is unique       | `doctors_mobile_uniq (hospital_id, mobile_e164)`             | Two doctors cannot share a mobile — also across reps.                                                                                                                                                                                      |
| Ownership              | `crm.doctor_assignments` (`effective_to IS NULL`)            | Reps see only doctors assigned to them (RLS `can_access_doctor`). **Reps cannot write assignments** (RLS: ceo_admin / head_of_growth / growth_manager only).                                                                               |
| Insert permission      | RLS `doctors_insert`                                         | Any growth role may insert a doctor, but it "lands unassigned" — so a rep could not even see the doctor they just added. §6 fixes this.                                                                                                    |
| Edit                   | `PATCH /crm/doctors/:id` → `fillDoctorGap`                   | Only fills 7 fields, **ignores blanks** (cannot clear a value), no validation of mobile/email, no page — only the "Quick add" chips on the visit form.                                                                                     |
| History                | `crm.audit_log` + `crm.audit_row()` trigger on doctors       | Every insert/update already logged with actor and changed fields. Nothing shows it.                                                                                                                                                        |
| Visit form             | `/crm/visit/:doctorId` (`AddVisitPage`) → `POST /crm/visits` | Works, offline queue, one visit per doctor per rep per day. Time is always **now**; status is only implied by Outcome; no back-dating.                                                                                                     |
| Visit sheet            | `/crm/visits/import`                                         | Status Completed / Doctor unavailable / Not visited; date back to start of this week or month (`uploadWindow`).                                                                                                                            |
| Admin tabs on CRM home | `RepHomePage` `ASSIGNMENTS_TAB`                              | Pattern to reuse for a "Delete requests" tab.                                                                                                                                                                                              |

## 3. Screens

### 3.1 Add doctor — `/crm/doctors/new`

Entry: **Add doctor** button in the CRM home action bar (next to Download my sheet / Upload
visits) and on the "My doctors" tab empty state.

Form (one column on phone, two on desktop), grouped:

- **Doctor** — Name\* (with "Dr" added if missing, never doubled — the "DR DR" case from the
  Sandeep sheet), Specialty (suggest list from existing values, free text allowed), Qualifications.
- **Contact** — Mobile\* (10-digit Indian mobile), WhatsApp (checkbox "Same as mobile"), Clinic
  phone, Email.
- **Clinic** — Clinic name, Address, Area\*, City, PIN (6 digits), Territory (select).
- **Classification** — Priority A / B / C / Not set. Notes.
- **Assigned to** — **admins only**: select from `ASSIGNABLE_ROLES` staff + "Unassigned".
  Reps never see it; the server assigns the doctor to them.

Before save the server checks the mobile (§6.3). After save → the new doctor's page, with
"Doctor added" and a **Log visit** button (adding usually happens during a visit).

### 3.2 Edit doctor — `/crm/doctor/:id/edit`

Entry: **Edit details** on the Doctor page (Doctor 360). Same form, prefilled.

- Fields can be changed **and cleared** (except the starred ones).
- Name and mobile changes show "Was: …" under the field so a wrong edit is visible before save.
- Admins also see **Assigned to** (reuses the existing reassign service, so history is kept).
- Save sends only changed fields. A conflict check (`updated_at` sent back) stops two people
  overwriting each other: "This doctor was changed by Sandeep at 11:42. Reload to see it."
- **History** section on the Doctor page: last 20 changes from `crm.audit_log` —
  "Mobile 98xxx → 99xxx · Rajesh Sharma · 27 Oct, 11:42".

### 3.3 Delete

On the Doctor page, a quiet **Remove doctor…** action (bottom, not next to Log visit).

- **Rep**: dialog "Request removal of Dr X (Area, mobile)" with reason select — Duplicate /
  Retired or moved / Not a doctor (chemist, RMP list error) / Not interested / Other — and a note
  (required for Other). Submit → banner on the doctor: "Removal requested 27 Oct · waiting for
  admin" with **Cancel request**. The doctor stays fully usable until approved.
- **Admin**: same dialog, button says **Remove doctor**; it removes at once (still records the
  reason). Confirmation states what happens (§5.3).
- One open request per doctor.

### 3.4 Delete requests — admin tab on CRM home

New tab **Removal requests (n)** for admins, like the Assignments tab: list of pending requests
— doctor, area, owner, requested by, reason, note, date, visits on record. Actions **Approve**
and **Reject** (reject needs a short note). Filter Pending / Approved / Rejected. The rep sees
the outcome on the doctor (rejected → note shown) and on a "My requests" filter.

Admins also get a **Removed doctors** filter there with **Restore** (undo a wrong approval).

### 3.5 Log visit form — upgrade the existing one

Keep `/crm/visit/:doctorId`; change it so it matches the sheet:

- **Status** first, required: **Completed** / **Doctor unavailable** (same labels as the sheet).
  Doctor unavailable sets outcome `doctor_unavailable` and hides the outcome chips.
- **Visit date**: Today by default; can pick an earlier date in the same window the sheet allows
  (start of this week or this month, whichever is earlier). Time = now for today, 10:00 IST for a
  past date (D3).
- Visit type, purpose, outcome, notes, next visit date — as today.
- One visit per doctor per rep per day stays — if one exists for that date (from app or sheet)
  the form says "Already logged for 25 Oct" with a link to it.
- **Faster entry**: a **Log visit** button on every row of _To visit_, _My doctors_ and _Today_
  on CRM home, so a rep does not open the doctor page first.

"Not visited" is not a record in the form (nothing happened); it stays a sheet-only value.

## 4. Who can do what

| Action          | Rep (own doctors)    | Rep (other's doctor) | Admin                         |
| --------------- | -------------------- | -------------------- | ----------------------------- |
| Add doctor      | Yes — owned by them  | —                    | Yes — assign to anyone / none |
| Edit details    | Yes, direct, audited | No (cannot see it)   | Yes, any doctor               |
| Change owner    | No                   | No                   | Yes                           |
| Remove          | Request only         | No                   | Direct, or approve/reject     |
| Restore removed | No                   | No                   | Yes                           |
| Log visit       | Yes                  | No                   | Yes, for doctors they see     |

The server enforces all of this; hiding buttons is only UX.

## 5. Data and rules

### 5.1 Migration `2026-10-27_crm_doctor_manage.sql`

```text
crm.doctor_removal_requests
  id uuid pk, hospital_id, doctor_id → crm.doctors
  requested_by → crm.users, reason text check (duplicate|left|not_a_doctor|not_interested|other),
  note text, status text check (pending|approved|rejected|cancelled) default pending,
  decided_by → crm.users, decided_at, decision_note, created_at, updated_at
  unique (doctor_id) where status = 'pending'
  + audit trigger, hard-delete block trigger, RLS:
    read: requester, the doctor's owner chain, admins
    insert: can_access_doctor(doctor_id)
    update: admins (decide); requester (cancel own pending)

crm.doctors: removed_reason text, removed_by uuid  (deleted_at already exists)

crm.add_doctor(p jsonb, p_owner uuid) security definer
  inserts the doctor and its current assignment in one go:
  - rep caller: owner forced to the caller
  - admin caller: owner = p_owner or null
  returns the id. Needed because reps cannot write doctor_assignments (§2).

crm.find_doctor_by_mobile(p_mobile text) security definer
  returns only {exists, mine boolean, owner_name} — no other fields — so a rep learns that a
  mobile is taken without seeing the other rep's doctor.
```

No backfill; existing rows untouched. Applied to the test DB first, production only when you say.

### 5.2 Edit rules (`server/crm/doctors.js`, replaces the narrow `fillDoctorGap` path)

- Whitelist of editable fields; trims; empty string → null (clears) except name, mobile, area.
- Mobile: 10-digit Indian (`shared/phone`), normalised; duplicate check (§6.3).
- Email format; PIN 6 digits; priority in A/B/C/unclassified; territory must exist.
- Name: collapse spaces, strip a doubled "Dr", tidy capitals (D4).
- `If-Unmodified` style check on `updated_at`.
- The Quick-add chips on the visit form keep working (they call the same service).

### 5.3 What removal does

On approve (or admin direct remove), in one transaction:

- `doctors.deleted_at = now()`, `removed_reason`, `removed_by`.
- Close the current assignment (`effective_to = now()`).
- Close open tasks for the doctor (status cancelled, note "Doctor removed").
- Visits, referrals and progress history **stay** (reports for past periods do not change);
  the doctor drops out of lists, To visit, coverage, sheet downloads and pickers from now on.
- Referrals still pointing at the doctor keep the name (needed for patient attribution).

Restore reverses `deleted_at` and re-opens an assignment to the previous owner — unless its
mobile has since been used by another doctor, then restore is refused with that reason.

### 5.4 Visits from the form

`logVisit` gets `status` and `visit_date`; validation shared with the sheet (`assessRow`
date-window rule) so both paths accept exactly the same dates. `source = 'app'`.

## 6. Edge cases

1. **Rep adds a doctor that already exists for them** → "Dr X is already on your list" + link.
2. **Mobile belongs to another rep's doctor** → "This mobile is already in the CRM under another
   team member (Sandeep Sangroy). Ask your admin to move the doctor to you." No other details.
3. **Same name, same area, different mobile** → warning, can still save ("Possible duplicate:
   Dr X, Balongi").
4. Doctor with no mobile (8 in Sandeep's sheet) → edit lets a rep add it; uniqueness applies.
5. Delete requested, then the doctor is reassigned → request stays with the doctor; new owner
   sees the banner.
6. Delete requested and visit logged after → allowed; admin sees "2 visits since request".
7. Two admins decide the same request → second gets "Already approved by Virender at 12:10".
8. Chemists (rows 10/19/32 of Sandeep's sheet) → reason "Not a doctor" covers them.
9. Offline: Add/Edit/Remove need a connection (show "You are offline"); only visits queue
   offline, as today.

## 7. API

| Method | Path                                              | Who                           |
| ------ | ------------------------------------------------- | ----------------------------- |
| GET    | `/crm/doctors/check-mobile?mobile=`               | CRM staff                     |
| POST   | `/crm/doctors`                                    | CRM staff                     |
| GET    | `/crm/doctors/:id/edit`                           | CRM staff (own) / admin       |
| PUT    | `/crm/doctors/:id`                                | CRM staff (own) / admin       |
| GET    | `/crm/doctors/:id/history`                        | CRM staff (own) / admin       |
| POST   | `/crm/doctors/:id/removal`                        | rep → request; admin → remove |
| POST   | `/crm/removal-requests/:id/cancel`                | requester                     |
| GET    | `/crm/removal-requests?status=&page=`             | admin                         |
| POST   | `/crm/removal-requests/:id/approve` / `reject`    | admin                         |
| POST   | `/crm/doctors/:id/restore`                        | admin                         |
| POST   | `/crm/visits` (existing) + `status`, `visit_date` | CRM staff                     |

Errors are plain sentences ("Enter a 10-digit mobile number."), never DB messages.
`PATCH /crm/doctors/:id` stays for the Quick-add chips.

## 8. Files

- Server: `server/crm/doctors.js` (new: add, edit, check mobile, history), `server/crm/removals.js`
  (new), `server/crm/visits.js` (status/date), `server/routes/crm.js`, `shared/crmVocab.js`
  (`DOCTOR_REMOVAL_REASONS`, `REMOVAL_STATUSES`).
- Client: `src/pages/crm/DoctorFormPage.jsx` (add + edit), `src/components/crm/doctors/*`
  (fields, history, removal dialog/banner), `RemovalRequestsPanel.jsx` (admin tab),
  `AddVisitPage.jsx`, `RepHomePage.jsx` (Add doctor button, Log visit on rows, new tab),
  `Doctor360Page.jsx` (Edit, Remove, History), `router.jsx` (lazy routes), `config/routes.js`
  (CRM_ACCESS — same capability as the rest of the CRM; admin-only parts checked by role
  server-side), `crm.css`.

## 9. Tests

- **API (C21)**: rep adds → owns it, sees it; admin adds for Sandeep → Rajesh cannot see it;
  duplicate mobile mine/other's/removed; edit + clear + validation messages + stale update;
  rep cannot edit other's doctor; request → approve → hidden from lists/coverage but past
  visits still counted; reject; cancel; double decide; restore + mobile clash; visit form
  status/date window/one-per-day across app and sheet.
- **UI (C22)**: add from home, edit and history, request removal and banner, admin approves
  from the tab, log visit from a home row, phone width without sideways scroll.
- RLS: extend the CRM guard suite for the new table.
- Full CRM suite + build before reporting.

## 10. Build order

1. Migration + RLS on the test DB → service + API tests (add/edit).
2. Add/Edit page + Doctor page buttons + history.
3. Removal requests (service, admin tab, banner) + tests.
4. Visit form status/date + Log visit on home rows + tests.
5. Review, responsive pass, full suite. Production migration only when you say.

## 11. Decisions (answered 2026-10-27)

| #   | Question                              | Decision                                                                                          |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D1  | Rep edits need approval?              | **No** — saved directly, every change in the doctor's history. Only removal needs approval.       |
| D2  | Admin adds a doctor — owner required? | **No** — pick a rep or leave Unassigned (assign later from Assignments).                          |
| D3  | Visit form dates                      | **Same window as the sheet** — today by default, back to start of this week or month.             |
| D4  | Name style                            | **Tidy** — "DR RAJESH KHANNA" → "Dr Rajesh Khanna"; doubled "Dr" removed.                         |
| D5  | Who approves removals                 | Virender (head of growth) and CEO/admin — the existing assigning roles (plan default, not asked). |
