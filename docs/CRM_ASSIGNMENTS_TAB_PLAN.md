# CRM home — "Assignments" tab for admin

Status: **built and tested 2026-10-17** (e2e/crm/C15-assignments-tab.spec.js).

## 1. Goal

On `/crm/home`, admin and the head of growth get a sixth tab, **Assignments**, answering at a
glance: which doctors are assigned, to whom, and which are still unassigned.

## 2. Who sees it

Only people who can import (`CRM_IMPORT` — admin, CEO, head of growth) and whose CRM role sees
every doctor (`ceo_admin`, `head_of_growth`). Growth managers and executives never see the tab,
and the API refuses them (403) — they already see only their own doctors under "My doctors".

## 3. UI

```
To visit · Referrals · Today · My doctors · Tasks · [Assignments]

Unassigned 120   Virender Satija 210   Rajesh Sharma 140   Sandeep Sangroy 117      ← counts, each a filter
[Search by doctor name, mobile or area]  [Owner ▾ All / Unassigned / each staff]  [Territory ▾]

Doctor (name · specialty · mobile)   Territory   Owner            Assigned on   By
Dr A Malhotra · Pediatrics · 99887…  Chandigarh  Rajesh Sharma    17 Oct 2026   Virender
Dr B …                               Mohali      — Unassigned
                                                       Page 1 of 12 · 587 doctors  [Prev] [Next]
```

- Counts row: Unassigned first (the number to drive to zero), then one tile per staff member.
  Clicking a tile filters the list.
- Search, owner and territory filters and pagination (50 per page) run on the server.
- Doctor name opens the existing Doctor 360 page.
- Empty, loading (skeleton rows), error with "Try again" states; works on a phone (cards
  stack, filters wrap) like the rest of the CRM home.

## 4. API

`GET /api/crm/assignments?owner=all|unassigned|<crm user id>&territory=&q=&page=`
→ `{ counts: { unassigned, total, by_owner: [{id, full_name, n}] }, rows: [...], page, pages, total }`

Reads `crm.doctors` + the open `crm.doctor_assignments` row (+ users for owner and "by"), through
`withCrmContext` so row-level security still applies. Gated by `CRM_IMPORT` on the route prefix
and the CRM-role check on the server.

## 5. Tests (local test DB)

- Counts: unassigned and per-owner numbers match the seeded data.
- Filters: owner = unassigned / one person, territory, search, paging past 50.
- Access: tab visible for admin/head; hidden and API 403 for manager/executive.
- Assignment from an import shows up with the right owner, date and "by".

## 6. Decisions (2026-10-17)

- Admin can **change** owners here too: a staff dropdown on each row, and select-many + "Assign
  to…" / "Remove owner" with a confirmation (max 100 per change). Every change closes the old
  assignment and opens a new one (`assigned_by`, reason "Assigned on CRM home"), so history is kept.
- **Export to Excel** of the current filter; its columns match the import template, so the file
  can be edited and re-imported.
- It is the 6th tab on `/crm/home`, opening on **Unassigned**.

API as built: `GET /api/crm/assignments`, `POST /api/crm/assignments`
`{ doctor_ids, executive_id | null }`, `GET /api/crm/assignments/export.xlsx`, all behind
`CRM_IMPORT` + the CRM-role check. The import's commit now writes assignments through the same
`applyAssignments` (server/crm/assignments.js).
