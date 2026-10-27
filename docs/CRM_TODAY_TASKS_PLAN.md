# CRM home — Today tab and Tasks tab

Status: **built 2026-10-27** — 8 API tests (C23), 4 browser tests (C24); full CRM suite 146 of 146. Migration applied to the test DB only. Build notes in §9.

## 1. Problem (from the code)

| Tab   | Shows today                                             | Why it is empty                                                                                 |
| ----- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Today | Visits **I** logged today (`repHome` → `todays_visits`) | Admins never log visits; reps see nothing about what is _planned_ today.                        |
| Tasks | My open tasks from `crm.tasks` (`listTasks`)            | Nothing in the CRM creates a task, and nothing can mark one done. The tab is permanently empty. |

Also: the visit form saves a **Next visit date** (`visits.next_visit_date`) but nothing reads it.
The To visit tab is driven only by the cadence policy (A/B every 15 days, C every 45).

## 2. Goal

- **Today** = "my day": what is due today (from the dates the rep chose), and what was done today.
  Admins get a team view.
- **Tasks** = the follow-up actions a rep owes: created automatically from visits, added by hand,
  assigned by admins, closed with Done or Cancel.

One source of truth: a follow-up visit **is a task** (kind `follow_up_visit`). Today's "Due"
list is those tasks, so the two tabs never disagree.

## 3. Tasks

### 3.1 Kinds

| Kind              | Created by                                                                                    | Closes                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `follow_up_visit` | Saving a visit (form or sheet) with a **Next visit date** → "Visit Dr X", due that date       | **Automatically** when the owner logs a visit to that doctor on/after the task was created; or Done/Cancel |
| `promise`         | Saving a visit with **What did you promise?** (commitments) filled → title = the promise text | Done / Cancel by hand                                                                                      |
| `manual`          | **+ Task** form                                                                               | Done / Cancel by hand                                                                                      |

Rules:

- One open `follow_up_visit` per doctor per owner: a newer visit replaces the older open one
  (old → cancelled, "Replaced by a newer next visit date").
- Editing a visit's next visit date (same-day edit) moves its task's due date; undoing the visit
  cancels its tasks.
- Promise task due date = next visit date if set, else visit date + 3 days.
- Owner = the rep who logged the visit. Removing a doctor already cancels its open tasks.

### 3.2 Tasks tab

- Filter chips: **Overdue · Today · Upcoming · Done (last 30 days)**, counts on each; default
  Overdue + Today first.
- Row: title, doctor (link), due date ("Due today", "3 days overdue"), priority, kind tag
  (Follow-up visit / Promise / Task), assigned by (when not self).
- Actions: follow-up visit → **Log visit** (primary) + Cancel; others → **Done** + Cancel
  (Cancel asks a short reason). Done/Cancel are undoable for 10 seconds ("Undo").
- **+ Task** (dialog): title*, doctor (optional, own doctors; admins any), due date*, priority,
  note; admins also **Assign to** (any rep).
- Admins: owner filter (All / each rep) and an Owner column.

## 4. Today tab

Rep view, top to bottom:

1. **Due today** — open `follow_up_visit` tasks due today or earlier (overdue first, with "since
   25 Oct"), each with **Log visit** and the doctor's area/mobile.
2. **Other tasks due today** — promise/manual tasks due today or overdue, with Done.
3. **Done today** — visits logged today (as now), with Edit/Undo for own visits.

Admin view adds, above that, **Team today**: one row per rep — visits today, unique doctors,
follow-ups due today, overdue follow-ups, overdue tasks. Tapping a rep filters the lists below
to that rep. Admin's own Due/Done stay below (usually empty).

Empty states say what to do ("Nothing due today. Set a Next visit date when you log a visit
and it shows here.").

The **To visit** tab stays as is (cadence-based) — Today is the rep's own plan, To visit is
the policy.

## 5. Data and API

Migration `2026-10-28_crm_tasks_kinds.sql`:

```text
crm.tasks: kind text not null default 'manual' check (kind in ('manual','follow_up_visit','promise')),
           cancel_reason text
unique index: one open follow_up_visit per (owner_id, doctor_id)
index: (owner_id, kind, status, due_date)
```

Server (`server/crm/tasks.js`, new): `listTasks` (bucket, owner for admins), `createTask`,
`completeTask`, `cancelTask`, `reopenTask` (the 10-second undo), `syncVisitTasks(sql, visit)`
called inside `logVisit`, sheet commit, `editVisit`, `undoVisit`; `todayView` (due, other
tasks, done, team for admins).

| Method | Path                        | Who                                  |
| ------ | --------------------------- | ------------------------------------ |
| GET    | `/crm/today?rep=`           | CRM staff (rep filter admins only)   |
| GET    | `/crm/tasks?bucket=&owner=` | CRM staff (owner filter admins only) |
| POST   | `/crm/tasks`                | CRM staff; admins may set owner      |
| POST   | `/crm/tasks/:id/done`       | owner / creator / admin              |
| POST   | `/crm/tasks/:id/cancel`     | owner / creator / admin              |
| POST   | `/crm/tasks/:id/reopen`     | same, within 10 minutes              |

Old visits' next visit dates are backfilled once (D3, §9).

## 6. Tests

API (C23): visit with next date → task; second visit replaces it; logging a visit closes it;
same-day edit moves it; undo cancels; promise task; manual task with/without doctor; admin
assigns to rep; rep cannot touch another rep's task; Today due/overdue/done; team rows only for
admins; removed doctor's tasks gone. UI (C24): Today due → Log visit → task closes; + Task;
Done/Undo; admin Team today; phone width.

## 7. Build order

1. Migration (test DB) + `tasks.js` + visit hooks + API tests.
2. Tasks tab UI (+ Task dialog, Done/Cancel/Undo).
3. Today tab UI (rep, then admin Team today).
4. Review, responsive, full CRM suite. Production migration only when you say.

## 8. Decisions

| #   | Question                 | Decision                                                                |
| --- | ------------------------ | ----------------------------------------------------------------------- |
| D1  | Today tab content        | **Due today + done**, admins also get Team today (answered 2026-10-27). |
| D2  | Tasks tab                | **Auto + manual**, Done/Cancel, admins assign (answered 2026-10-27).    |
| Q1  | Backfill old next dates? | Open — default: no; only visits saved after release create tasks.       |

## 9. Build notes (2026-10-27)

- Migration `2026-10-28_crm_tasks_kinds.sql`: `tasks.kind`, `cancel_reason`,
  `closed_by_visit_id`, one-open-follow-up unique index, two indexes, and
  `crm.staff_name(uuid)` — a definer function so a rep can see who assigned them a task
  (reps cannot read other staff rows directly).
- `server/crm/tasks.js`: `syncVisitTasks` (close follow-ups on a completed visit, replace with
  the newest next visit date, add promise tasks), `visitNextDateChanged`, `visitsUndone`
  (cancel the visit's tasks, reopen what it closed), `listTasks`, `createTask`,
  `completeTask`, `cancelTask`, `reopenTask`, `todayView`. Hooked into `logVisit`, `editVisit`,
  `undoVisit`, sheet commit and sheet undo. The old `homeLists.listTasks` and
  `/crm/home/tasks` route were removed; `/crm/tasks` replaces them.
- A **Doctor unavailable** visit does not close a follow-up (the doctor still needs visiting);
  a Completed visit does, if its date is on or after the day the follow-up was created.
- Client: `components/crm/tasks/{TodayPanel, TasksPanel, TaskRow, TaskDialog,
useTaskActions, taskText}`; `RepHomePage` uses them; `home/TasksList.jsx` deleted.
- Backfill: for each rep and doctor, the latest visit's next visit date becomes one open
  follow-up — only if the rep still owns the doctor and no follow-up exists. Dry run by default,
  100 per batch, safe to rerun, `created_at` set to the visit time so a later visit closes it.
- Production: run the migration, then the backfill dry run, report counts, then `--apply`.
- 2026-10-27 change: the visit form's **Needs a follow-up** box controls the follow-up. Unticked
  → no next visit date is stored and no task is made; ticked → the date (pre-filled from
  priority) is required and must be after the visit date. Sheet rows count as ticked when a Next
  visit date is filled. The 36 production tasks backfilled before this change (all from unticked
  visits) were **kept** by decision; the backfill script now only uses ticked visits.
