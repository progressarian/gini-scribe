# 65 — Chief Endocrinologist suggests advice and care plan

Status: plan (2026-10-12). Not built.

## Why

Advice and the care plan (treatment, lifestyle, goals, next visit) print on the prescription under
the consultant's name. Today only the consultant can write them (`DoctorConsultPage` →
`AdviceSection`, `CarePlanSection`, one `giniflow_care_plans` row per visit). The Chief
Endocrinologist sees the patient first and often knows what the advice should be, but has only a
free-text **Plan** handover note.

The Chief must be able to put it forward **without** writing on the consultant's prescription — the
same model as medicines, where the Chief's changes are proposals the consultant decides
(`giniflow_rx_proposals`, `ProposalsStrip`, finalize blocked while any is undecided).

## Decisions (2026-10-12)

| #   | Decision                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| S1  | The Chief **suggests**; only the consultant's accepted or typed text prints. Suggestions never print.                          |
| S2  | Suggestions are per field — **advice, treatment, lifestyle, goals, next visit** — so each is accepted or dismissed on its own. |
| S3  | The consultant can **Accept**, **Edit then accept**, or **Dismiss** each one.                                                  |
| S4  | Like medicine proposals, an undecided suggestion **blocks Finish consultation** — decided, never defaulted.                    |
| S5  | The Chief can change or withdraw a suggestion until the consultant decides it; after that it is read-only.                     |
| S6  | Every suggestion keeps who proposed it, who decided it, when, and the outcome.                                                 |

## Data

New table `giniflow_plan_suggestions`:

| Column                                                | Meaning                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id` uuid, `visit_id` → `giniflow_visits`             |                                                                                             |
| `field`                                               | `advice` \| `treatment` \| `lifestyle` \| `goals` \| `next_visit`                           |
| `value` jsonb                                         | text for advice/treatment/lifestyle; goal list for goals; `{date, interval}` for next visit |
| `proposed_by` → `doctors`, `created_at`, `updated_at` |                                                                                             |
| `status`                                              | `proposed` \| `accepted` \| `edited` \| `dismissed` \| `withdrawn`                          |
| `decided_by`, `decided_at`, `decision_note`           |                                                                                             |

At most one `proposed` row per `(visit_id, field)` (partial unique index): the Chief's edits update
it in place (autosave), they do not pile up rows.

## Behaviour

### B1. Chief Endocrinologist station

A section **📝 Suggest advice & care plan** under "💊 Suggest to the doctor":

- **Advice** — the same common-advice picker the consultant uses (`useVisitAdvice` list), plus free text.
- **Treatment**, **Lifestyle** — text boxes.
- **Goals** — the consultant's goal rows.
- **Next visit** — date or interval.
- Header line: _"A suggestion, not a prescription — the doctor decides."_
- Autosaves each field as its suggestion while the patient is at the Chief's desk (`with_sd`).
  Clearing a field withdraws its suggestion.
- A field the consultant has decided shows the outcome ("✓ Accepted", "Edited by the doctor",
  "Dismissed — reason") and is read-only.

### B2. Consultant page

Suggestions appear in **🩺 Chief Endo proposed** (`ProposalsStrip`), below the medicine proposals,
each with the Chief's value and **Accept · Edit · Dismiss**:

| Field                        | Accept does                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Advice, Treatment, Lifestyle | Added to the consultant's text (appended on a new line; set when empty).                       |
| Goals                        | Goals added to the consultant's goal list (same goal not added twice).                         |
| Next visit                   | Sets the next visit. If the consultant already set one, both are shown and Accept replaces it. |

**Edit** opens the value prefilled; saving records it as `edited` and applies the edited value.
**Dismiss** asks for an optional reason. The consultant's own sections (`AdviceSection`,
`CarePlanSection`) refresh immediately after an accept.

### B3. Finish consultation

`pendingProposalCount` also counts `giniflow_plan_suggestions` in `proposed`, so finalize refuses
with "Decide the Chief Endocrinologist's suggestions first" — the existing medicine rule.

### B4. Prescription

Unchanged: it prints `giniflow_care_plans` (consultant-owned). Accepted text is already copied
there; pending, dismissed or withdrawn suggestions are never read by the print path.

### B5. Access

Chief station capability creates, edits and withdraws suggestions, only while the patient is at
their desk. Doctor station capability decides them. Both checked server-side.

## Not in scope

- Voice/AI filling of the suggestion fields.
- Changing the Chief's free-text **Plan** handover note.
- Suggestions on the Online journey without a Chief step (nothing to suggest from).

## Tasks (each tested before the next)

1. Migration + service: save/withdraw (Chief), list, decide (consultant) with the accept rules. Tests
   per field and outcome; consultant's care plan updated on accept; nothing written on dismiss.
2. Routes on the Chief and doctor station routers with capability checks. Tests: wrong role refused,
   Chief refused once the patient left their desk.
3. Finalize guard counts pending suggestions. Test.
4. Chief station section (B1). Screen test.
5. Consultant `ProposalsStrip` rows (B2). Screen test: accept advice, dismiss goals, finish allowed
   only after both decided.

## Open questions

1. **Accept advice — append (proposed) or replace** the consultant's existing advice?
2. **Block Finish while a suggestion is undecided (proposed, as medicines do)**, or only warn?
