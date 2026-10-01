# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Gini Clinical Scribe — clinical documentation and patient-flow system for Gini Advanced Care Hospital, Mohali. Turns doctor–patient voice consultations into structured prescriptions, tracks patients physically through the OPD floor, ingests labs/documents from the hospital's HIS (HealthRay), and syncs to the MyHealth Genie patient app. The core value: surface patient history, current reports, and vitals on one page so doctors decide faster and can see more patients per day.

Roles: admin, consultant, mo (medical officer), nurse, lab, tech, reception, coordinator, pharmacy, obt (call/lead/appointment-confirmation team, works the `/ghm` sheet), guest. Must stay GDPR/DPDP-compliant (patient data handling, Aadhaar encryption, access control).

`README.md` has the full write-up (architecture diagram, consultation flow, patient-flow routes, external systems, full env var table, API surface, medicine matching algorithm) — read it before making non-trivial changes; this file only adds what the README doesn't.

## Commands

```bash
npm install && cd server && npm install   # two separate node_modules — client and server/worker

npm run dev          # prettier + Vite (:3000) + API (:3001) together
npm run dev:client   # Vite only
npm run dev:server   # API only (nodemon, no cron)
npm run dev:worker   # cron/sync loops only

npm run build          # vite build -> dist/
npm run format          # prettier --write, run before committing
npm run format:check

# e2e (Playwright) — runs against a LOCAL Docker Postgres, never production
npm run test:e2e:setup                        # one-time / after adding a migration: start postgres (port 5435), rebuild gini_scribe_test
npm run test:e2e                              # everything (own API on :3101, Vite on :3100)
npm run test:e2e -- e2e/billing/phase4/P4-13-finalise.spec.js   # one file
npm run test:e2e:billing                      # billing suite
E2E_REBUILD=1 npm run test:e2e                # rebuild the schema first

npm run check:giniflow       # static checks for the Gini Flow screens (undefined refs + style tokens)

# from server/ — smoke scripts (`node scripts/smoke-*.mjs`), many hit the DB in .env
npm run smoke:billing-pricing   # see server/package.json for the full smoke:* list
npm run analytics:report     # regenerate the outcomes report HTML (--snapshot to persist)

# apply one migration (from server/)
node migrations/_runOne.mjs migrations/<file>.sql
```

There is no linter; Prettier plus the Playwright suite in `e2e/` are the automated checks. `e2e/README.md` covers the test DB: every connection is forced through `e2e/setup/guard.mjs` (only `localhost:5435/gini_scribe_test`), the test API gets blanked credentials from `e2e/.env.e2e`, and outbound network calls are blocked. Fixture users/patients/tests live in `e2e/fixtures/data.mjs` (PIN `4321`). CI (`.github/workflows/crm-guards.yml`) only runs the `server/crm/` guards and RLS/compliance suite.

`server/scripts/` holds many ad-hoc diagnostic/backfill/sync scripts; run individually with `node`. Put new one-offs there, not in the repo root.

⚠️ `DATABASE_URL` in `.env` points at **production** — `npm run dev`, smoke scripts and anything in `server/scripts/` touch live patient data. The only non-production database is the e2e test DB above. Treat migrations, backfills, and one-off scripts accordingly.

## Architecture

Three processes, one Postgres database:
- **Client** (`src/main.jsx` → `src/router.jsx`) — React 18 + Vite SPA, react-router, TanStack Query, Zustand.
- **API** (`server/index.js`) — Express; every `server/routes/*.js` mounted flat under `/api`; also serves the built SPA from `dist/`.
- **Worker** (`server/worker.js`) — all cron/sync loops (HealthRay, lab API, Genie, Google Sheets). Runs separately from the API so a slow HealthRay sync can't starve request handling; `server/config/db.js` exposes two pools (`pool` for requests, `cronPool` for background jobs). `RUN_CRON_IN_API=1` collapses both into one process for local dev.

Routes are HTTP-only and delegate to `server/services/*` for domain logic (`healthray/`, `lab/`, `cron/`, `flow/`, `agent/` SQL-tool AI agent, `medication/`). Request bodies validate against `server/schemas/index.js` (Zod) via `middleware/validate.js`.

**RBAC**: `shared/permissions.js` is the single source of truth, imported by both the frontend (`src/config/routes.js` → `RequireCapability`) and backend (`server/middleware/auth.js`). Adding a page or endpoint means updating capabilities on both sides. `GRANT_ALL_CAPABILITIES` is now `false`, so the per-role matrix **is** enforced on both sides — a new page or endpoint is inaccessible until its capability is granted to the relevant roles. `shared/` also holds other client/server-shared vocabularies (`callStatuses`, `patientCategories`, `patientBlockReasons`, `patientLists`, `followUp`, `phone`, `slotHour`); import from there instead of redefining the strings.

**Auth**: JWTs are doctor or patient kind (a `kind` claim), validated against `auth_sessions` for real revocation on logout/expiry. Accepted as `x-auth-token`, `Authorization: Bearer`, or `?token=` (query form so image/PDF URLs can self-authenticate). Public paths are listed explicitly in `server/middleware/auth.js`.

**Consultation flow**: voice → Deepgram/Whisper transcription → Claude structured extraction → `src/medmatch.js` fuzzy-matches drugs against `src/medicine_db.json` (~6,900 brands) → doctor reviews across a multi-page wizard → `POST /api/consultations` saves atomically (BEGIN…COMMIT) → non-blocking Genie sync. A consultation is a sequence of routes, not one page (new patient: `/intake → /history-clinical → /exam → /assess → /plan`; follow-up: `/fu-load → /fu-review → /fu-edit → /fu-symptoms → /fu-gen`). In-progress state lives in `src/stores/visitStore.js` + sibling stores, persisted fire-and-forget to `active_visits` (route/status/`step_data` JSONB) so it survives reloads/devices; there is no visit id in the URL, so reads scope by `patient_id`.

**Patient flow** (`/flow/*`, `server/services/flow/`, `server/routes/flow.js`): tracks a patient physically moving check-in → vitals/MO/lab/dietitian/Rx stations → pharmacy exit. `/visit/:token` is the public patient-facing journey tracker (opaque token, no login).

**Gini Flow** (`/giniflow/*`, `server/services/giniflow/`, `server/routes/giniflow.js` + `giniflowStations.js`) is the current floor system: one `giniflow_visits` row per patient per day (created by `appointmentSync.js` from HealthRay/Scribe appointments, unique per `appointment_id`), station screens under `/giniflow/station/{reception,mo,doctor,lab,machine,rx,pharmacy…}`, and lab/machine test orders in `giniflow_lab_orders` (+ `_tests`, `_events`). Reception's Payments tab clears test orders; the Bill tab of the same page is the billing counter. Design docs are the numbered `docs/gini-flow/NN-*.md` series.

**Billing** (`server/services/billing/`, routes `billing.js` desk + `billingMaster.js` admin, UI `src/components/billing/` and Settings → Services):
- Master: `service_groups → service_subgroups → service_items`; test items must link a `giniflow_test_catalog` row. Ordered/lab-report test names resolve to items through `testMatch.js` `TEST_MATCHES_SQL` (aliases in `service_item_aliases` win, then exact/flattened/word matches on the catalogue).
- Pricing: `priceLine.js` (category rate → per-patient `agreed_rate` → `base_price`, then payment rules and line discounts) and `priceBill.js` (bill-level discounts; package rules with `requires_all_items` apply first). Every change reprices the whole bill (`bills.js reprice`).
- Bills: draft → final/cancelled, credit notes for refunds; lines carry a `source` (`visit`, `lab_order`, `lab_case`, `added`, `ordered`). Drafts are auto-filled at the counter from the consultation, floor orders and the HealthRay lab report; paying a bill settles its linked floor orders (`payments.js settleTestOrders`). Drafts opened at the counter stay unsaved until Save draft (`bills.saved_at` / `saved_snapshot`).
- `billing_audit` is append-only (DB trigger) — every master, bill, line and payment change is written there via `writeAudit`.

**HealthRay** is the authoritative source for appointments, visit completion, labs, and scanned documents — it has no webhooks, so sync is self-rescheduling polling loops in `server/services/cron/`, deliberately slow (~2-3 min) because tight polling trips its WAF into a 403 IP-block; `HEALTHRAY_PROXY_URL` routes traffic through a static-IP proxy as the permanent fix. `labapi.healthray.com` is a separate system with separate credentials from `node.healthray.com`. Patient identity keys on `health_id`, not `file_no` (UHID) — HealthRay reassigns UHIDs to different people over time.

**Database**: `server/schema.sql` is only the starting point — real schema is `schema.sql` + every dated file in `server/migrations/` applied in order. DATE columns parse as strings (configured in `config/db.js`) to avoid timezone off-by-one errors.

**Client details**: every page is lazy-loaded through `lazyWithRetry` in `src/router.jsx`, which force-reloads once on a stale-chunk error after a deploy — keep new routes on that helper. `src/companion/` + `src/Companion.jsx` are a separate phone-shaped capture UI (document photos, appointment list) sharing the same auth and API. In dev, Vite proxies `/api` to `http://localhost:3001`; override with `VITE_DEV_API_URL`.

**Env**: both API and worker load the repo-root `.env` (`server/loadEnv.js` resolves it relative to `server/`) — there is no `server/.env`. `VITE_*` vars are inlined into the browser bundle at build time.

**Docs**: `docs/*_PLAN.md` and `docs/gini-flow/NN-*-PLAN.md` are per-feature design docs written before each feature (flow stations, lab flow, OBT role, prescription flow, patient blocklist, MSG91 messaging, billing…). Read the matching plan before changing that area; `docs/archive/` is superseded.

## Conventions

- No comments in code — names should carry meaning; keep code minimal and clean.
- Before writing new code, check for existing utilities/components/services that already do it (`src/lib`, `src/utils`, `src/services`, `server/services`) rather than duplicating.
- Use correct semantic HTML (e.g. `<button>` for clickable actions, not a `div` with `onClick`).
- Follow MVC-style separation: routes (HTTP) → services (domain logic) → db; keep components/pages modular.
- Break work into small tasks; test each one before moving to the next rather than doing one large change.
- Do not commit or push to git unless explicitly asked.


## Gini Production UI / UX Standards

These rules apply to all new UI and all meaningful changes to existing UI. The goal is a production-grade clinical operations portal, not a marketing site, design prototype, or generic dashboard.

The interface must optimize for:

- Fast daily operation
- Clinical readability
- Patient safety
- Workflow clarity
- Data accuracy
- Low cognitive load
- Consistent behavior
- Accessibility
- Auditability
- Desktop productivity
- Reliable use with real-world data

Do not optimize for visual novelty at the expense of workflow speed or clarity.

### 1. Product UI Direction

Gini is a clinical and hospital operations system. The UI should feel like mature enterprise healthcare software combined with modern productivity software.

Target characteristics:

- Clean
- Calm
- Precise
- Professional
- Information-dense
- Easy to scan
- Consistent
- Trustworthy
- Fast

Avoid:

- Gaming-dashboard aesthetics
- Neon/futuristic UI
- Excessive gradients
- Large decorative illustrations
- Excessive glassmorphism
- Marketing-style hero sections
- Huge typography
- Excessive rounded cards
- Decorative animations
- Excessive shadows
- Unnecessary visual effects

The UI should stay visually quiet so patient and operational data remain the focus.

### 2. Existing Design System First

Before creating UI:

1. Inspect existing components.
2. Inspect existing Tailwind classes and CSS variables.
3. Inspect existing shadcn/Radix components.
4. Reuse existing patterns.
5. Only introduce a new pattern when an existing one genuinely cannot support the requirement.

Do not create a second design system.

Do not rewrite existing screens simply to make them look different.

Do not introduce a new UI library without a strong technical reason.

### 3. Layout

Standard authenticated portal structure:

```text
App Shell
├── Sidebar
├── Header
└── Main
    ├── Page Header
    ├── Filters / Search
    ├── Summary when useful
    └── Main Content
```

Use consistent page padding and spacing.

Prefer a stable desktop layout because reception, billing, consultation, lab, and clinical workflows are primarily operational desktop workflows.

The content area must remain usable at common laptop resolutions.

Do not allow tables or clinical content to become unnecessarily narrow because of oversized sidebars or decorative elements.

### 4. Page Header

Preferred structure:

```text
Page title
Short context/description when useful

                              [Secondary] [Primary Action]
```

Rules:

- Use one obvious primary action.
- Keep secondary actions visually quieter.
- Avoid multiple competing primary buttons.
- Do not add descriptions when they provide no useful context.
- Do not place large decorative elements beside page titles.

### 5. Navigation

Sidebar/navigation must be:

- Stable
- Predictable
- Role-aware
- Easy to scan
- Consistent

Group navigation logically around actual hospital workflows.

Examples:

```text
Overview

Patients
Appointments
Patient Flow
Consultations
Lab
Billing
Pharmacy

Reports
GHM

Administration
Settings
Users
```

Do not expose routes/actions that the user's role cannot legitimately use.

The frontend must continue using the existing RBAC capability system. UI visibility is not a replacement for backend authorization.

### 6. Role-Based UI

Role-specific interfaces should expose the actions needed by that role without overwhelming users with unrelated functionality.

Examples:

Reception:
- Registration
- Appointments
- Patient flow
- Billing
- Payments
- Refund payout where permitted

Consultant:
- Patient history
- Vitals
- Reports
- Consultation
- Prescription
- Follow-up

MO:
- Patient assessment
- Vitals
- Clinical workflow
- Lab/diagnostic actions where permitted

Lab:
- Lab queue
- Tests
- Reports
- Matching/order workflow

Pharmacy:
- Prescription
- Medicine workflow
- Dispensing

Admin:
- Configuration
- Billing settings
- Approvals
- Reports
- User/permission management

Do not assume these permissions independently of `shared/permissions.js`.

### 7. Patient Safety

Patient identity must always be visually clear when working with clinical or billing data.

Where appropriate, display:

```text
Patient Name
Health ID
Relevant visit/context
Current status
```

Avoid relying on only a name.

For sensitive actions, show enough identifying context to prevent acting on the wrong patient.

Before irreversible actions, confirm:

- Patient
- Bill/order/visit
- Affected item
- Amount where applicable
- Resulting status

### 8. Patient Detail Pages

Patient pages should prioritize information doctors and staff actually need.

Recommended hierarchy:

```text
Patient Header
├── Name / Health ID / Status
├── Important contextual information
└── Primary actions

Clinical Summary
Vitals
Reports / Documents
Consultations
Prescriptions
Visits / Flow
Billing
Activity / Audit
```

Use tabs when sections are substantial.

Do not turn every small section into a separate tab.

Do not hide clinically important information behind unnecessary clicks.

### 9. Clinical Information

Clinical data must be readable before it is visually impressive.

Prefer:

- Clear section headings
- Strong label/value hierarchy
- Compact but readable spacing
- Consistent units
- Consistent date/time formatting
- Clear abnormal/status indicators

Avoid:

- Tiny text
- Dense paragraphs
- Decorative charts without clinical value
- Color-only warnings
- Excessive card nesting

Do not infer medical meaning from data in the UI. Display the source information accurately.

### 10. Consultation Wizard

The consultation workflow is multi-step and must clearly communicate progress.

For:

```text
/intake
/history-clinical
/exam
/assess
/plan
```

and:

```text
/fu-load
/fu-review
/fu-edit
/fu-symptoms
/fu-gen
```

show:

- Current step
- Completed steps
- Remaining steps
- Save/progress state when relevant

The user must always know:

1. Where they are.
2. What has been completed.
3. What remains.
4. How to move forward/back.

Do not make the wizard visually heavy.

### 11. Voice / AI Extraction UX

AI-generated transcription or structured clinical content must never look identical to confirmed doctor-entered information when the distinction matters.

Where applicable, communicate:

```text
Generated
Suggested
Needs Review
Confirmed
```

The doctor must remain clearly in control of final clinical content.

Do not auto-hide uncertainty.

Do not silently overwrite manually edited clinical information.

### 12. Medicine Matching

When a medicine is matched from voice/transcription:

- Show the selected medicine clearly.
- Make alternatives understandable.
- Make uncertainty/review states visible where applicable.
- Avoid presenting an inferred match as though it were manually confirmed.
- Keep final selection/editing under the appropriate clinician workflow.

### 13. Patient Flow

The patient-flow interface must optimize for fast station-based operation.

Typical workflow:

```text
Check-in
→ Vitals
→ MO
→ Consultant
→ Lab / Diagnostics
→ Dietitian
→ Prescription Explain
→ Pharmacy
→ Exit
```

The current station/status must be immediately obvious.

Prefer:

```text
Patient
Current station
Current status
Next action
Elapsed/waiting information where useful
```

Avoid requiring staff to open several screens just to understand where a patient currently is.

### 14. Workflow Statuses

Use consistent semantic states.

Examples:

```text
Waiting
In Progress
Completed
Cancelled
Blocked
Pending Payment
Paid
Pending Approval
Approved
Rejected
Refund Pending
Ready for Payout
Paid Back
```

Do not create different labels for the same state across pages.

Use a shared status vocabulary where one already exists.

Statuses should not rely on color alone.

Use label + appropriate visual treatment.

### 15. Operational Tables

Tables are a primary UI pattern in Gini.

Use them for:

- Patients
- Appointments
- Billing
- Tests
- Refunds
- Lab queues
- Reports
- Staff
- GHM
- Audit/activity

Production tables should support where relevant:

- Search
- Filters
- Sorting
- Pagination
- Row actions
- Bulk actions
- Empty state
- Loading state
- Error state

Do not add every possible column.

Prioritize the fields needed to complete the workflow.

### 16. Table Density

Default table density should support daily hospital operations.

Avoid:

- Excessive row height
- Excessive whitespace
- Tiny unreadable text

Use compact density when the table is operational and users need to scan many records.

Use comfortable density for clinical details where readability is more important.

### 17. Long / Real-World Data

Design for actual production data:

- Long patient names
- Long medicine names
- Long test names
- Large billing amounts
- Long order numbers
- Missing optional values
- Duplicate-looking names
- Large result sets
- Long notes
- Unexpected external-system values

Do not design only around short mock values.

Use truncation carefully and provide a way to inspect the complete value.

### 18. Search and Filters

Search placeholders should explain what can be searched.

Examples:

```text
Search by patient name, Health ID or phone
Search bills by number or patient
Search tests or orders
```

For multiple filters:

```text
[Search...] [Status] [Date] [Department] [More Filters]
```

When filters are active:

- Make the active state visible.
- Provide clear/reset behavior.
- Preserve filters when appropriate.

Do not make simple filters unnecessarily difficult to access.

### 19. Forms

All forms must have:

- Visible labels
- Clear required-field indication
- Helpful validation
- Field-level error messages
- Loading state
- Disabled state
- Predictable submit/cancel behavior

Use React Hook Form and Zod when consistent with the existing implementation.

Do not rely only on placeholders as labels.

### 20. Validation

Error messages should tell the user how to fix the problem.

Bad:

```text
Invalid input
```

Better:

```text
Enter a valid phone number.
```

For financial/clinical operations, validation must happen before an irreversible action.

Do not expose raw database/API errors.

### 21. Loading States

Every asynchronous workflow needs a clear state.

Use:

- Skeletons for page/table loading
- Button loading for mutations
- Progress indicators for long-running operations

Examples:

```text
Saving...
Finalizing...
Submitting refund...
Syncing...
```

Do not make users wonder whether an action was submitted.

Do not replace the entire application with a spinner for a small request.

### 22. Empty States

Empty states must explain why the user sees an empty result and what they can do.

Bad:

```text
No data
```

Better:

```text
No refunds found

No refunds match the current filters.

[Clear Filters]
```

First-use states may include a primary action:

```text
No services configured

Add a service to start billing.

[Add Service]
```

### 23. Error States

Errors must be actionable and safe.

Example:

```text
Unable to load billing records.

Please try again. If the problem continues, contact an administrator.

[Try Again]
```

Never expose:

- SQL errors
- Stack traces
- Internal service names
- Credentials
- Tokens
- Infrastructure details

### 24. Toasts

Use the existing notification system, including Sonner where already established.

Good:

```text
Bill finalized successfully.
Refund request submitted.
Patient updated successfully.
```

Do not use toasts as the only communication for critical financial or clinical actions.

Important results should also appear in the relevant page/workflow.

### 25. Billing UI

Billing is a high-risk operational workflow and must be visually explicit.

Clearly distinguish:

```text
Draft
Finalized
Paid
Partially Paid
Due
Cancelled
Refund Requested
Refund Approved
Refunded
```

Bill actions must depend on bill state.

Example:

```text
Draft
→ Edit
→ Finalize

Finalized
→ Print
→ Collect Payment
→ Refund where permitted

Refunded
→ View Credit Note
→ View Refund Receipt
```

Do not show actions that are invalid for the current state.

### 26. Financial Amounts

Use consistent currency formatting.

Example:

```text
Subtotal          ₹2,500.00
Discount           -₹250.00
GST                ₹405.00
----------------------------
Total             ₹2,655.00
Paid              ₹2,000.00
Due                 ₹655.00
```

Rules:

- Align monetary values consistently.
- Make total/paid/due visually distinct.
- Do not rely on color alone.
- Avoid ambiguous abbreviations.
- Preserve exact values.
- Show refund amounts explicitly.

### 27. Payment UI

Payment workflows must clearly show:

```text
Amount
Payment status
Payment method
Reference where applicable
Remaining due
```

Methods may include:

```text
Cash
Card
UPI
As Paid
Pay Later
```

Do not allow users to accidentally submit an amount different from the intended amount.

### 28. Refund UI

Refunds must be treated as high-risk financial actions.

Before submission, show:

```text
Patient
Bill
Selected items
Original amount
Refund amount
Refund method
Reason where required
```

Example:

```text
Refund Summary

Patient: John Doe
Bill: BL-2026-00128

Selected Items
Consultation       ₹800
Lab Test           ₹450
------------------------
Refund Total      ₹1,250

Refund Method
( ) As Paid
( ) Cash
( ) Card
( ) UPI

Reason
[................................]

[Cancel] [Submit Refund]
```

After submission, show the resulting state clearly.

### 29. Refund Statuses

Use a consistent workflow such as:

```text
Waiting for Admin
Approved to Pay
Rejected
Paid Back
```

If the existing backend vocabulary differs, use the existing backend/shared vocabulary instead of creating another one.

Reception, admin, and other roles should see only the actions permitted to them.

### 30. Credit Notes and Receipts

Credit notes and refund receipts must expose:

- Reference number
- Patient
- Original bill
- Refunded items
- Amount
- Refund method
- Date/time
- Appropriate status

Provide clear print/PDF actions.

Do not mix credit-note information with unrelated UI.

### 31. Irreversible Actions

For:

```text
Refund
Cancel Bill
Void
Credit Note
Reject
Finalize
Write-off
```

confirmation should communicate:

1. What will happen.
2. Which patient/entity is affected.
3. Which amount/items are affected.
4. The resulting status.
5. Any irreversible consequence.

Avoid generic:

```text
Are you sure?
```

### 32. Lab UI

Lab workflows should make these relationships clear:

```text
Patient
Order
Test
Result
Report
Billing status
Workflow status
```

When matching reports/orders, show enough identifying information to reduce incorrect matches.

Do not make order number matching dependent on ambiguous labels.

### 33. HealthRay Integration UX

HealthRay is an external authoritative system and may be delayed.

Where synchronization state matters, distinguish:

```text
Synced
Syncing
Pending Sync
Failed
Not Available
```

Do not imply that data is synchronized when it has not been confirmed.

For delayed synchronization, show useful status/context rather than exposing technical polling details.

Do not display internal WAF/proxy implementation details to normal users.

### 34. Sync and Background Operations

Long-running operations should communicate state without blocking unrelated workflows.

Examples:

```text
Sync pending
Last synced: 10:42 AM
Retry available
```

Avoid making users repeatedly submit the same action because background work is still processing.

### 35. Auditability

For important actions, the UI should make available where appropriate:

```text
Who
What
When
Reason
Reference
Previous state
New state
```

Especially for:

- Refunds
- Payments
- Discounts
- Bill cancellation
- Credit notes
- Approvals/rejections
- Permission changes
- Configuration changes

### 36. Print / PDF

Bills, receipts, credit notes, prescriptions, reports and other formal documents need dedicated print layouts.

Print output must:

- Hide application navigation
- Preserve important references
- Preserve totals
- Use readable typography
- Handle page breaks
- Avoid UI-only controls
- Match the required external/hospital format where specified

Do not simply print the screen.

### 37. Modals

Use dialogs for:

- Confirmation
- Small focused forms
- Important decisions
- Compact previews

Do not put large multi-step clinical workflows into dialogs.

Use dedicated pages or drawers for substantial workflows.

### 38. Drawers

Use drawers for:

- Quick patient details
- Secondary information
- Filter panels
- Contextual inspection

Avoid nested:

```text
Modal → Drawer → Modal
```

patterns.

### 39. Action Menus

For tables, keep the primary row action visible and put secondary actions in a predictable menu.

Example:

```text
View
Edit
Print
More...
```

Do not place a dozen buttons in every row.

### 40. Cards

Use cards only when they improve grouping or hierarchy.

Good:

- KPI summaries
- Distinct patient information sections
- Important workflow summaries
- Settings groups

Avoid:

```text
Card inside card inside card
```

Do not wrap every table, section and field in a separate rounded container.

### 41. Status Badges

Status badges should be:

- Consistent
- Compact
- Readable
- Semantic

Do not invent different badge styles for the same status.

Do not rely only on red/green/yellow.

### 42. Accessibility

Use semantic HTML.

Required:

- Keyboard navigation
- Visible focus states
- Proper labels
- Accessible dialogs
- Accessible menus
- Sufficient contrast
- Meaningful button labels
- Form error association
- Color-independent status communication

Use `<button>` for actions and links for navigation.

Do not make clickable `div` elements.

### 43. Responsive Behavior

Gini is primarily an operational desktop application, but all important screens must remain usable on smaller screens.

Desktop:

```text
Sidebar + Header + Main
```

Tablet:

```text
Collapsible navigation + responsive content
```

Mobile:

```text
Compact navigation
Single-column forms
Scrollable or transformed data tables
Accessible primary actions
```

Do not merely shrink desktop content.

Do not hide clinically or financially critical information solely to avoid horizontal scrolling.

### 44. Tables on Mobile

For large operational tables, use one of:

1. Horizontal scrolling
2. Responsive priority columns
3. Card/list representation
4. Detail drawer

Choose based on the workflow.

Do not remove critical identifiers, amounts, or statuses without an alternative way to inspect them.

### 45. Typography

Use restrained, readable typography.

Recommended hierarchy:

```text
Page title       20–24px
Section title    16–18px
Body             14px
Table            14px
Helper text      12–13px
```

Do not use oversized headings inside operational screens.

Readable data is more important than visual drama.

### 46. Spacing

Use a consistent spacing scale.

Prefer:

```text
4
8
12
16
20
24
32
40
48
```

Typical:

```text
Page padding       24px
Section spacing    24–32px
Form gap           16px
Card padding       16–20px
Button gap         8px
```

Do not introduce arbitrary spacing values without a reason.

### 47. Color

Use the existing design tokens.

Prefer semantic tokens:

```text
background
foreground
muted
primary
secondary
accent
destructive
border
input
ring
```

Do not scatter hard-coded colors throughout components.

Semantic states may use restrained success/warning/error/info treatments.

Avoid excessive saturation.

### 48. Dark Mode

If the existing application supports dark mode:

- Use semantic tokens.
- Maintain readable contrast.
- Avoid pure black everywhere.
- Avoid pure white text everywhere.
- Keep hierarchy between background, surface, border and text.

Do not create separate ad-hoc dark-mode colors inside individual pages.

### 49. Animation

Animation should communicate state.

Use subtle transitions around 150–200ms where appropriate.

Good:

- Dialog entrance
- Dropdown
- Hover
- Expand/collapse
- Loading

Avoid:

- Continuous decorative animation
- Bouncing UI
- Large page transitions
- Slow interactions
- Excessive motion

Respect `prefers-reduced-motion`.

### 50. Component Reuse

Prefer reusable components for repeated patterns:

```text
PageHeader
DataTable
FilterBar
SearchInput
StatusBadge
EmptyState
ErrorState
LoadingState
ConfirmDialog
FormField
ActionMenu
SectionHeader
MoneyDisplay
DateDisplay
Pagination
```

Do not duplicate the same UI pattern across multiple pages.

### 51. Component Design

Prefer business-meaningful APIs.

Good:

```tsx
<StatusBadge status="paid" />
```

Avoid:

```tsx
<StatusBadge
  color="green"
  background="light"
  text="Paid"
  icon="check"
/>
```

Use variants instead of excessive boolean styling props.

Avoid prop explosion.

### 52. State Management

Use the project's existing architecture.

- TanStack Query for server state.
- Zustand for established client/workflow state.
- React local state for local UI state.
- React Hook Form for complex forms.

Do not duplicate server state unnecessarily.

### 53. Query and Mutation UX

After mutations:

- Invalidate or update affected queries.
- Update visible state promptly.
- Prevent duplicate submissions.
- Show mutation loading state.
- Handle failure visibly.

Do not make the user refresh the page to see a successful mutation.

### 54. Optimistic Updates

Use optimistic updates only when the result is predictable and failure can be safely reconciled.

Do not optimistically finalize financial or irreversible clinical transactions unless the underlying workflow explicitly supports it.

### 55. Production Data

Always design against real data rather than ideal mock data.

Test mentally and visually with:

- Long names
- Long notes
- Large numbers
- Missing fields
- Duplicate names
- Large tables
- Failed requests
- Slow requests
- Empty datasets
- Partial external data
- Unexpected HealthRay values

### 56. Security

Never display:

- Passwords
- JWTs
- API keys
- Secrets
- Internal infrastructure details
- Raw database errors

Patient information must only be shown to authorized users and within the scope permitted by the existing RBAC/auth architecture.

Do not add sensitive data to URLs, logs, analytics events, or client-visible errors unnecessarily.

### 57. Privacy

The application handles clinical and personal information.

UI changes must preserve privacy principles:

- Show only necessary patient information.
- Avoid exposing sensitive information in notifications.
- Avoid sensitive information in browser titles where unnecessary.
- Do not expose patient data to unauthorized roles.
- Do not use patient information as decorative UI content.

### 58. Performance

Operational screens must remain responsive.

Prefer:

- Pagination
- Debounced search
- Lazy-loaded routes
- Efficient queries
- Minimal unnecessary re-renders
- Virtualization for genuinely large lists
- Lightweight components

Do not render thousands of rows when only a page of results is required.

Keep the existing `lazyWithRetry` route loading behavior.

### 59. No Fake Functionality

Never implement fake:

- API responses
- Pagination
- Loading states
- Notifications
- Permissions
- Charts
- Sync status
- Financial calculations

If backend support does not exist, build the UI around the actual intended contract or clearly leave the integration point incomplete.

Never make an action appear successful when the backend did not confirm it.

### 60. No Unrelated UI Changes

When implementing a feature:

1. Inspect the existing page.
2. Identify reusable components.
3. Follow the existing visual language.
4. Implement only the required UI/UX changes.
5. Do not redesign unrelated pages.
6. Do not replace working components without a reason.
7. Do not modify unrelated backend logic.

### 61. UI Review Checklist

Before considering a UI feature complete:

```text
[ ] Existing components/design tokens were reused.
[ ] Page purpose is immediately clear.
[ ] One primary action is obvious.
[ ] Secondary actions are visually quieter.
[ ] Role permissions are respected.
[ ] Patient identity is clear where required.
[ ] Loading state exists.
[ ] Empty state exists.
[ ] Error state exists.
[ ] Disabled state exists.
[ ] Success feedback exists.
[ ] Destructive actions are confirmed.
[ ] Financial amounts are explicit.
[ ] Statuses are consistent.
[ ] Tables handle real data.
[ ] Long values do not break the layout.
[ ] Search/filter behavior is clear.
[ ] Forms have labels and validation.
[ ] Keyboard navigation works.
[ ] Focus states are visible.
[ ] Mobile/tablet behavior is considered.
[ ] Print/PDF behavior is considered where applicable.
[ ] No sensitive information is unnecessarily exposed.
[ ] No fake functionality was introduced.
[ ] No unrelated screens were redesigned.
[ ] No unnecessary dependency was added.
[ ] Existing RBAC architecture remains the source of truth.
```

### 62. Final Gini UI Principle

When choosing between two UI implementations, prefer the one that lets a real hospital staff member complete the task:

- faster,
- with fewer clicks,
- with less cognitive load,
- with clearer patient identity,
- with fewer opportunities for mistakes,
- and with an obvious understanding of the current workflow state.

The UI should disappear behind the work.

Clinical data, patient safety, operational clarity, and correctness always take priority over visual novelty.