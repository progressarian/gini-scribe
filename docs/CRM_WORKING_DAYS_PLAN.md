# CRM working days — Sundays, holidays and leave out of the averages

Status: **built 2026-11-10** on the local e2e DB — migration `2026-11-10_crm_days_off.sql`, API
tests C26, UI tests C27, RLS checks in `verify_rls.sh` §(l). Production migration applied 2026-11-10.

Build notes: holidays are added and removed as one request (a multi-day holiday is removed
together); working days are computed in `server/crm/daysOff.js` from the approved rows in range;
a Sunday with visits still shows in the by-day chart, marked as Sunday. API and working-day
checks share C26; the UI file is C27.

## 1. Goal

Field staff do not work on Sundays, on hospital holidays, or on days they are on leave. Today the
CRM counts every calendar day, so those days drag every "per day" reading down and make a week
with Diwali or a sick day look like a bad week.

After this change:

- The Progress dashboard shows **Visits per working day** for each person and for the team, where
  working days leave out **Sundays**, **holidays** and **approved leave**.
- Admins mark **holidays** (whole team) on any date.
- Staff **request leave** for themselves; it only counts once an admin **approves** it. Admins can
  also enter approved leave for anyone directly.
- The **Visits by day** chart drops Sundays and labels holiday and leave days.

## 2. Decisions taken (2026-11-10)

| #   | Question                               | Decision                                                                                                                       |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Who marks holidays                     | **Admins only**: `ceo_admin` and `head_of_growth` (the existing `crm.is_growth_lead()` roles, same people who assign doctors). |
| D2  | How leave is marked                    | **Staff request, admin approves.** Admins can also add leave for anyone, approved straight away.                               |
| D3  | Do days off change due dates / overdue | **No, averages only for now.** Due dates, overdue days, overdue doctors and coverage stay calendar-day based. Phase 2 (§11).   |
| D4  | Chart                                  | **Hide Sundays** in the by-day chart; **holiday and leave days stay, greyed and labelled**.                                    |
| D5  | Visits on a day off                    | **Visits count, the day stays off** — extra work raises the average.                                                           |
| D6  | Half days                              | **Allowed for leave.** A half day of leave takes **0.5** off working days. Holidays are always full days.                      |
| D7  | Home bar                               | **Yes** — one "Per working day" stat added to the This month bar.                                                              |

## 3. What exists today (from the code)

- There is **no average anywhere** in the CRM. `/crm/progress` shows totals with "vs before"
  deltas (`server/crm/progress.js`, `ProgressCards.jsx`, `StaffTable.jsx`), and the home bar shows
  month counts (`RepHomePage.jsx` → `server/crm/visits.js` `performance`).
- `ProgressTrend.jsx` draws one bar per calendar day (`buckets()` in `progress.js`), so every
  Sunday is an empty bar.
- No table or setting for holidays or leave exists.
- Weeks already start Monday in IST (`server/crm/istPeriods.js` `mondayOf`), so a week is Mon–Sun
  with six possible working days.
- The approval pattern to copy is **doctor removal requests** (`crm.doctor_removal_requests`,
  `server/crm/removals.js`, the "Removal requests" tab, `RemovalRequestsPanel.jsx`): pending →
  approved / rejected / cancelled, RLS, `block_hard_delete` and `audit_row` triggers.

## 4. Working-day rule (the one formula everything uses)

For one person and a date range `from … to`:

```
end           = min(to, today IST)
calendar days = from … end
working days  = calendar days
                − Sundays
                − holidays (active, not removed)
                − that person's approved leave (full day = 1, half day = 0.5)
```

- **Today counts** as a working day once it has started, so "Today" and "This week" read as
  "so far". (Totals already include today, so the two agree.)
- A day that is both a holiday and leave is subtracted once.
- **Visits logged on a day off still count** in the visit totals and in the average's numerator;
  the day stays off (D5).
- Working days can end in `.5` because of half-day leave (e.g. `17.5`); shown with one decimal
  only when it is not whole.
- **Visits per working day** = visits ÷ working days, **one decimal** (e.g. `6.4`). When working
  days = 0 the card shows `—` with the note "No working days in this period".
- **All staff** = total visits ÷ **sum of each person's working days** (person-days), so one rep on
  leave lowers only their own share.
- **Previous period** uses the same rule on its own dates, so "vs before" compares like with like.

## 5. Database — one new table

`server/migrations/2026-11-10_crm_days_off.sql`

```sql
crm.days_off
  id            uuid pk default gen_random_uuid()
  hospital_id   uuid not null  → crm.hospitals
  kind          text not null  check in ('holiday','leave')
  day           date not null  check (extract(isodow from day) <> 7)     -- never a Sunday
  user_id       uuid           → crm.users   -- null for holiday, required for leave
  request_id    uuid not null  -- groups the days of one request so it is approved in one click
  title         text           -- holiday name, e.g. "Diwali" (required for holiday)
  note          text           -- leave reason (optional, max 200)
  portion       text not null default 'full' check in ('full','half')
                check (kind = 'leave' or portion = 'full')               -- holidays are whole days
  status        text not null default 'pending'
                check in ('pending','approved','rejected','cancelled')
  requested_by  uuid not null  → crm.users
  decided_by    uuid           → crm.users
  decided_at    timestamptz
  decision_note text
  created_at, updated_at, deleted_at timestamptz
  check ((kind = 'holiday') = (user_id is null))
```

- Holidays are inserted **already approved**.
- Unique indexes (only rows still in play):
  - one holiday per `(hospital_id, day)` where `status = 'approved' and deleted_at is null`
  - one leave per `(user_id, day)` where `status in ('pending','approved') and deleted_at is null`
- Indexes: `(hospital_id, day)`, `(user_id, day)`, `(request_id)`, `(status, created_at desc)`.
- Triggers, same as every CRM table: `set_updated_at`, `block_hard_delete` (no hard deletes —
  removing a holiday sets `deleted_at`; cancelling leave sets `status = 'cancelled'`), `audit_row`.
- **RLS** (FORCE, `crm_app` gets SELECT/INSERT/UPDATE):
  - read: own hospital **and** (`kind = 'holiday'` **or** `user_id = me` **or** growth lead)
  - insert: growth lead (anything) **or** (`kind = 'leave'`, `user_id = me`, `requested_by = me`,
    `status = 'pending'`)
  - update: growth lead **or** (own leave, and the new status is `cancelled`, from `pending`)
- Additive only; nothing existing changes. Applied with `SET LOCAL lock_timeout = '5s'` after the
  usual `pg_stat_activity` check. Added to `CRM_MIGRATIONS` in `.github/workflows/crm-guards.yml`
  (the "every CRM migration is in the chain" step enforces it) and to `verify_rls.sh`.

## 6. Server

New `server/crm/daysOff.js` (routes stay thin in `server/routes/crm.js`):

| Endpoint                                 | Who            | Does                                                                                                                                                                         |
| ---------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET  /api/crm/days-off?from&to&status`  | everyone       | Holidays in range; own leave (rep) or everyone's leave (admin), with person name, status, request grouping, pending count.                                                   |
| `POST /api/crm/holidays`                 | admin          | `{ from, to, title }` → one approved row per non-Sunday day in range.                                                                                                        |
| `POST /api/crm/holidays/:id/remove`      | admin          | Soft-removes the holiday (every day of that request) with `deleted_at`.                                                                                                      |
| `POST /api/crm/leave`                    | everyone       | `{ from, to, half_day, note, user_id? }`; `half_day` only allowed when from = to. Rep: own leave, **pending**. Admin: anyone's leave (picked from staff list), **approved**. |
| `POST /api/crm/leave/:requestId/approve` | admin          | Approves every pending day of the request.                                                                                                                                   |
| `POST /api/crm/leave/:requestId/reject`  | admin          | `{ note }` required. Rejects every pending day.                                                                                                                              |
| `POST /api/crm/leave/:requestId/cancel`  | owner or admin | Owner: pending days only. Admin: pending or approved days (e.g. leave not taken).                                                                                            |

Validation (field-level messages, `400` with `fields`, never raw DB errors):

- Dates are real `YYYY-MM-DD`; `from ≤ to`; range at most **31 days**.
- Half day only for a single date: "A half day can only be one date — set To the same as From."
- Sundays inside a range are skipped silently; a range that is **only** Sundays → "Pick at least
  one day that is not a Sunday."
- Rep leave: from **7 days back** to **90 days ahead** ("Leave can be requested from 7 days ago up
  to 3 months ahead."). Admin: up to one year back or ahead.
- Leave on a day already a holiday is skipped; leave on a day already requested → "You already have
  leave on 12 Nov." (lists the clashing days).
- Holiday title: required, letters/numbers/spaces, max 60.
- Reject note: required, max 200.

**Working days in the report** — `progress.js` `reportData` gains one more JSON part computed in
the same single query (no extra round trip), for current and previous ranges:

```sql
SELECT r.id AS executive_id,
       sum(CASE WHEN approved half-day leave for r.id on g.day THEN 0.5 ELSE 1 END) AS working_days
  FROM unnest($1::uuid[]) r(id)
  CROSS JOIN generate_series($2::date, least($3::date, IST_TODAY), '1 day') g(day)
 WHERE extract(isodow FROM g.day) <> 7
   AND NOT EXISTS (holiday on g.day)
   AND NOT EXISTS (approved full-day leave for r.id on g.day)
 GROUP BY GROUPING SETS ((r.id), ())
```

`shape()` gains `visits.working_days`, `visits.days_off` and `visits.per_working_day`. Trend
buckets gain `working_days` and, for day buckets, `off: 'holiday' | 'leave' | null`; Sunday day
buckets are no longer produced. Max range stays 366 days (≤ 366 × 3 staff rows — trivial).

## 7. UI

### 7.1 Progress dashboard (`/crm/progress`)

- **Visits and coverage** section: new card **Visits per working day** after Visits — value `6.4`,
  note "18 working days · 3 days off", and the usual "vs before" delta (one decimal). Working days with a half day read `17.5`.
- **Staff table** (admin, All staff): two columns after Visits — **Working days** and **Per
  working day** (sortable; total row uses person-days).
- **Visits by day** chart: no Sunday bars; a holiday or (single person view) leave day is a grey
  bar slot labelled "Holiday · Diwali" / "Leave" in the tooltip. By-week tooltip adds
  "5 working days". Month grouping unchanged apart from the tooltip.
- **Excel export**: Summary adds "Working days" and "Visits per working day"; Staff sheet adds the
  two columns; Trend sheet drops Sunday rows and adds a "Day off" column; footer line reads
  "Working days leave out Sundays, holidays and approved leave."

### 7.2 Home bar (`/crm/home`)

One more stat in the "This month" bar: **Per working day** (this month so far), same rule. No other
change to the bar.

### 7.3 New CRM home tab — **Holidays & leave** (everyone)

Same tab pattern and styles as "Removal requests" (`rep__*` classes, `ListPager`); kept in the URL
`?tab=leave` like the other tabs.

- **Rep view**
  - Primary action **Request leave** → small dialog: From, To (date inputs), Reason (optional),
    a **Half day** checkbox (enabled only when From = To), a line "3 working days · Sunday 16 Nov
    skipped" (or "Half day"), **Send request**.
  - "My leave" list: dates, days (`0.5` for a half day), status badge (Waiting for approval / Approved / Rejected with the
    note / Cancelled), **Cancel** on pending.
  - "Upcoming holidays" list (read only).
- **Admin view** (`ceo_admin`, `head_of_growth`)
  - **Waiting for approval** list at the top with a count on the tab ("Holidays & leave (2)"):
    person, dates, days, reason, **Approve** / **Reject** (reject asks for a note).
  - **Holidays**: **Add holiday** (Name, From, To) and a list of upcoming/past holidays with
    **Remove** (confirm dialog naming the date and holiday).
  - **Leave**: all staff leave with filters Person / Status, **Add leave** (pick person — approved
    at once), **Cancel** on approved leave (confirm dialog naming person and dates).
- Labels on every field, field-level errors, busy states on buttons, empty states ("No leave
  requested yet."), errors through `errorText`. Mobile: single-column dialogs, lists as rows.

### 7.4 Vocabulary

`shared/crmVocab.js`: `DAY_OFF_KINDS` and `DAY_OFF_STATUSES` (labels above), checked by
`checkVocabSync.mjs` against the migration's CHECK lists like the other CRM vocabularies.

## 8. What does **not** change (D3)

Due dates, "To visit", overdue doctors, overdue days on tasks, coverage %, follow-up dates and the
visit-sheet upload window all keep calendar-day counting. A rep back from a week's leave will still
see their doctors as overdue. Phase 2 (§11) covers that.

## 9. Tests (local e2e DB only — no test data in production)

- **C26-days-off-api.spec.js**: holiday add/remove (admin only, Sunday rejected, duplicate day
  blocked); rep leave → pending, not counted; approve → counted; reject needs a note; cancel rules;
  rep cannot request for someone else or approve own; 7-days-back / 90-days-ahead / 31-day limits;
  RLS — rep cannot read another rep's leave.
- **C27-working-days-progress.spec.js**: fixed dates with a known Sunday, holiday and leave →
  exact `working_days` and `per_working_day` for one rep and for All staff; previous period;
  Sunday bars absent; holiday/leave days flagged; zero-working-day period shows `—`.
- **C28-days-off-ui.spec.js**: rep requests leave, admin approves from the tab, progress card
  changes; validation messages; mobile width.
- Existing CRM suites (C19/C20 progress, C16/C23/C24 home) rerun.
- CI: migration in the chain, compliance, `verify_rls.sh` additions, both smoke scripts.

## 10. Build order (each step tested before the next)

1. Migration on the local e2e DB + RLS checks.
2. `daysOff.js` + routes + C26.
3. Working days in `progress.js` + export + C27.
4. Progress UI (card, staff columns, chart) and home stat.
5. Holidays & leave tab + C28.
6. CI list, full CRM suite, `npm run build`, format.
7. Production migration — **only after you say so**.

## 11. Later (not in this build)

- **Phase 2 — due dates**: skip Sundays, holidays and the owner's approved leave when counting
  overdue days and overdue doctors (visit-due view and task queries).
- First-half / second-half choice for half days; a person-specific weekly off other than Sunday; leave types (sick / casual);
  notifications to admins when leave is requested.

## 12. Open questions

None — D1–D7 answered on 2026-11-10.
