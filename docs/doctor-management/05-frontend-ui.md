# 05 — Frontend / UI

Stack: React + Vite, React Router (`src/router.jsx`), TanStack Query, Zustand
stores (`src/stores/`). RBAC nav via `RequireCapability` /
`shared/permissions.js`. New code mirrors existing page conventions
(`src/pages/*Page.jsx` + co-located `.css`, lazy-loaded route).

---

## 1. New route & nav

```js
// src/router.jsx — add alongside the other lazyEl routes
{ path: "/doctor-management", element: lazyEl(DoctorManagementPage) },
```
- Gated by `CAPABILITIES.ADMIN` / `SCHEDULE_MANAGE` for write tabs; the
  read-only availability view can be reachable by `RECEPTION_OPS`.
- Add a nav entry in `AppLayout.jsx` under the admin/reception section.

---

## 2. `DoctorManagementPage` — tabs

```
┌──────────────────────────────────────────────────────────────┐
│  Doctor Management                          [ Doctor: ▾ ]     │
│  ┌──────────┬──────────┬─────────┬───────────┬─────────────┐  │
│  │ Weekly   │ Breaks   │ Leave / │ Emergency │ Day         │  │
│  │ Schedule │          │ Holiday │ Leave     │ Availability│  │
│  └──────────┴──────────┴─────────┴───────────┴─────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Tab 1 — Weekly Schedule (grid editor)
Grid: **rows = slots** (from `slot_catalog`), **columns = Sun…Sat**. Click a
cell to toggle "works / off"; a small number field sets capacity. Save →
`PUT /api/doctors/:id/schedule` (replace-set).

```
            Sun  Mon  Tue  Wed  Thu  Fri  Sat
9:30–10 AM   ·   [5]  [5]  [5]  [5]  [5]   ·
10–11 AM     ·   [5]  [5]  [5]  [5]  [5]   ·
11–12 PM     ·   [5]  [5]  [5]  [5]  [5]   ·
12–1 PM      ·   [3]  [3]  [3]  [3]  [3]   ·
1–2 PM       ·    L    L    L    L    L    ·      L = recurring break (lunch)
2–2:30 PM    ·   [5]  [5]  [5]  [5]  [5]   ·
…
( · = off,  [n] = working, capacity n,  L = break overlay )
```

### Tab 2 — Breaks
List of recurring breaks + "Add break" (weekday or "every day" + slot + reason).
Rendered as the `L` overlay on Tab 1. CRUD → `/api/doctors/:id/breaks`.

### Tab 3 — Leave / Holiday
- Calendar (reuse `src/components/DatePicker.jsx`) + list of upcoming leave.
- "Add leave": date range, **whole day** vs **specific slots** (multiselect from
  catalog), reason. → `POST /api/doctors/:id/unavailability`.
- If the response has `affected[]`, immediately open the **Reassignment modal**
  (shared with Tab 4) seeded with those patients.

### Tab 4 — Emergency Leave (the headline)
- Big primary button: **"Mark Emergency Leave"**.
- Modal: window (default *rest of today*, toggle for date range / specific
  slots / `from_now`), reason → `POST /api/doctors/:id/emergency-leave`.
- Response opens the **Reassignment screen** (§3) with the affected patients +
  per-patient suggested doctors.

### Tab 5 — Day Availability (read-only verify)
Pick a date → calls `GET /api/doctors/:id/availability?date=` → shows each slot
green/grey with the blocking reason. Lets reception sanity-check before booking.

---

## 3. Reassignment screen / modal (shared by Flows B & C)

```
┌─ Reassign patients — Dr. Bhansali unavailable 8 Jun (rest of day) ──────────┐
│                                                                             │
│  ⚠ 4 patients are booked during this window. Assign each to another doctor. │
│                                                                             │
│  Patient            Slot          Reassign to                  Status       │
│  ───────────────────────────────────────────────────────────────────────   │
│  Ramesh K (GNI-123) 11–12 PM      [ Dr. Mehta  ▾ ] ⭐same spec  ○ pending    │
│  Sita D  (GNI-145)  12–1 PM       [ Dr. Mehta  ▾ ]             ○ pending    │
│  Arjun P (GNI-150)  2–2:30 PM     [ — none free — find slot ]  ⚠ no doctor  │
│  Maya R  (GNI-160)  in-progress    (locked — patient mid-visit) 🔒 skipped   │
│                                                                             │
│  [ Auto-fill suggestions ]                     [ Cancel ]  [ Reassign all ] │
└─────────────────────────────────────────────────────────────────────────────┘
```

Behaviors:
- Each "Reassign to" dropdown is populated from `suggested_doctors` (ranked;
  "⭐same spec" badge); falls back to a full available-doctor search for that
  slot.
- **"Auto-fill suggestions"** pre-selects the top suggestion for every movable
  row (human still confirms with "Reassign all").
- Rows with no available doctor show **"find slot"** → opens a forward search
  (next slot/day) or a "park for CC follow-up" action.
- In-progress patients are **locked** (not movable).
- "Reassign all" → `POST /api/appointments/reassign`. Partial failures
  (`target_full`) keep those rows on screen with an error; the rest commit.
- Screen cannot be dismissed as "done" while any movable row is still pending
  (guard against silently stranding a patient).

---

## 4. Booking UI change (enforcement surfacing)

Wherever a doctor+slot is currently picked for an appointment (GHM page
`src/pages/GHMPage.jsx`, OPD `src/OPD.jsx`, companion `DoctorSelect.jsx`):

- Fetch `GET /api/doctors/:id/availability?date=` and **render only available
  slots as selectable**; grey out the rest with a tooltip reason
  ("On leave", "Lunch break", "Clinic holiday", "Full").
- On submit, handle `409 doctor_unavailable` gracefully: show the reason inline
  and (for admins) offer a "book anyway (override)" affordance that resends with
  `force=true`.
- These pages already consume `/doctors` and slot data, so this is an additive
  fetch + conditional rendering, not a rewrite.

---

## 5. Data layer (TanStack Query keys)

```
['slot-catalog']
['doctor-schedule', doctorId]
['doctor-breaks', doctorId]
['doctor-unavailability', doctorId, fromMonth]
['doctor-availability', doctorId, date]
['available-doctors', date, slot]            // reassignment picker
```
Mutations (`PUT schedule`, `POST break`, `POST unavailability`,
`POST emergency-leave`, `POST reassign`) invalidate the relevant keys + the
appointments/availability keys used by GHM/OPD so the booking grid refreshes
instantly after a leave is added.

---

## 6. Reuse inventory (don't rebuild)

| Need | Existing piece |
|------|----------------|
| Date picking | `src/components/DatePicker.jsx` |
| Toasts / errors | `src/components/Toast.jsx`, `Err.jsx`, `PageErrorBoundary.jsx` |
| Capability gating | `src/components/RequireCapability.jsx` + `shared/permissions.js` |
| Doctor list | existing `GET /api/doctors` (login dropdown already uses it) |
| Slot labels | new `GET /api/slot-catalog` (or existing `/appointment-slots/time-slots`) |
| Auth/me, role | `src/stores/authStore.js` |
