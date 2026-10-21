# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/giniflow/G75-chief-step-per-consultant.spec.js >> G75 the Chief Endocrinologist step follows the consultant's setting >> 2. after vitals, Dr Banshali's patient waits for the chief; Dr Beant's goes to the consultant
- Location: e2e/giniflow/G75-chief-step-per-consultant.spec.js:79:3

# Error details

```
Error: P4 ChiefYes da0fac is resting for 10 minutes at the station so the BP reads true — ready in 10 min
```

# Test source

```ts
  385 |   const { rows: last } = await db.query(
  386 |     `SELECT weight, height, bp_sys, bp_dia, bp_standing_sys, bp_standing_dia, waist, body_fat,
  387 |             pulse, spo2, temp, recorded_at
  388 |        FROM vitals
  389 |       WHERE patient_id = $1 AND recorded_at::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
  390 |       ORDER BY recorded_at DESC LIMIT 1`,
  391 |     [visit.patient_id],
  392 |   );
  393 | 
  394 |   const { rows: current } = await db.query(
  395 |     `SELECT weight, height, bmi, bp_sys, bp_dia, bp_standing_sys, bp_standing_dia, waist, body_fat,
  396 |             pulse, spo2, temp, source, recorded_at
  397 |        FROM giniflow_vitals WHERE visit_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
  398 |     [visitId],
  399 |   );
  400 | 
  401 |   return {
  402 |     visitId: visit.id,
  403 |     patientId: visit.patient_id,
  404 |     name: visit.name,
  405 |     fileNo: visit.file_no,
  406 |     age: visit.age,
  407 |     sex: visit.sex,
  408 |     visitNumber: visit.visit_number,
  409 |     category: visit.category,
  410 |     stability: visit.stability
  411 |       ? { state: visit.stability, reasons: visit.stability_reasons || [] }
  412 |       : null,
  413 |     status: visit.current_status,
  414 |     checkedInAt: visit.checked_in_at ? new Date(visit.checked_in_at).toISOString() : null,
  415 |     restUntil: isResting(vitalsRestUntil(visit.current_status, visit.called_at))
  416 |       ? vitalsRestUntil(visit.current_status, visit.called_at)
  417 |       : null,
  418 |     allergyStatus: visit.allergy_status || ALLERGY_NOT_ASKED,
  419 |     allergyNote: visit.allergy_note || null,
  420 |     lastVisit: last[0] || null,
  421 |     recorded: current[0] || null,
  422 |     skipsChief: await planSkipsChief(db, visitId),
  423 |   };
  424 | }
  425 | 
  426 | // Saving is one transaction: the reading, the status move, and the event that
  427 | // carries the numbers so the timeline shows them without a join.
  428 | // The allergy answer, recorded against the PATIENT rather than the visit: it is
  429 | // true of them tomorrow too, and every station reads it from there
  430 | // (24-ADDENDUM-V11-PLAN.md §5.1).
  431 | //
  432 | // Only ever moves the answer forward. "Not asked" cannot overwrite a recorded
  433 | // allergy — a nurse tabbing past the control must not erase what somebody was
  434 | // told last month.
  435 | export async function saveAllergy(visitId, { status, note = null, actorId = null }, db = pool) {
  436 |   if (!["not_known", "none_known", "known"].includes(status)) {
  437 |     throw Object.assign(new Error(`Unknown allergy state: ${status}`), { status: 400 });
  438 |   }
  439 |   if (status === "known" && !note?.trim()) {
  440 |     throw Object.assign(new Error("Name the allergy before recording it"), { status: 400 });
  441 |   }
  442 |   const { rows } = await db.query(
  443 |     `UPDATE patients p
  444 |         SET allergy_status = CASE
  445 |               WHEN $2 = 'not_known' AND p.allergy_status IS NOT NULL THEN p.allergy_status
  446 |               ELSE $2 END,
  447 |             allergy_note = CASE
  448 |               WHEN $2 = 'known' THEN $3
  449 |               WHEN $2 = 'none_known' THEN NULL
  450 |               ELSE p.allergy_note END,
  451 |             allergy_asked_at = CASE WHEN $2 = 'not_known' THEN p.allergy_asked_at ELSE NOW() END,
  452 |             allergy_asked_by = CASE WHEN $2 = 'not_known' THEN p.allergy_asked_by ELSE $4 END
  453 |        FROM giniflow_visits v
  454 |       WHERE v.id = $1 AND p.id = v.patient_id
  455 |       RETURNING p.allergy_status, p.allergy_note`,
  456 |     [visitId, status, note?.trim() || null, actorId],
  457 |   );
  458 |   if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  459 |   return rows[0];
  460 | }
  461 | 
  462 | export const planSkipsChief = (db, visitId) => skipsChiefStop(db, visitId);
  463 | 
  464 | async function refuseWhileResting(client, visitId) {
  465 |   const { rows } = await client.query(
  466 |     `SELECT p.name,
  467 |             (e.occurred_at + make_interval(mins => $2))::timestamptz AS rest_until,
  468 |             CEIL(EXTRACT(EPOCH FROM (e.occurred_at + make_interval(mins => $2) - NOW())) / 60)::int
  469 |               AS minutes_left
  470 |        FROM giniflow_visits v
  471 |        JOIN patients p ON p.id = v.patient_id
  472 |        JOIN LATERAL (
  473 |          SELECT occurred_at FROM giniflow_visit_events ev
  474 |           WHERE ev.visit_id = v.id AND ev.status = 'with_vitals'
  475 |           ORDER BY occurred_at DESC LIMIT 1
  476 |        ) e ON TRUE
  477 |       WHERE v.id = $1 AND v.current_status = 'with_vitals'
  478 |         AND e.occurred_at + make_interval(mins => $2) > NOW()
  479 |         AND NOT ${REST_SKIPPED_SQL("v")}`,
  480 |     [visitId, VITALS_REST_MINUTES],
  481 |   );
  482 |   if (!rows.length) return;
  483 |   const { name, rest_until: restUntil, minutes_left: minutesLeft } = rows[0];
  484 |   throw Object.assign(
> 485 |     new Error(
      |     ^ Error: P4 ChiefYes da0fac is resting for 10 minutes at the station so the BP reads true — ready in 10 min
  486 |       `${name} is resting for ${VITALS_REST_MINUTES} minutes at the station so the BP reads true — ready in ${minutesLeft} min`,
  487 |     ),
  488 |     { status: 409, restUntil: new Date(restUntil).toISOString() },
  489 |   );
  490 | }
  491 | 
  492 | async function moveOnFromVitals(client, visitId, actorId, meta) {
  493 |   const moved = await advanceStatus(client, {
  494 |     visitId,
  495 |     toStatus: "vitals_done",
  496 |     actorRole: "vitals",
  497 |     actorId,
  498 |     allowSkip: true,
  499 |     meta,
  500 |   });
  501 |   return moved.status;
  502 | }
  503 | 
  504 | export async function skipVitals(visitId, { reason, actorId = null }, db = pool) {
  505 |   const client = await db.connect();
  506 |   try {
  507 |     await client.query("BEGIN");
  508 |     const visit = await client.query(
  509 |       `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
  510 |       [visitId],
  511 |     );
  512 |     if (!visit.rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  513 |     if (!QUEUE_STATUSES.includes(visit.rows[0].current_status))
  514 |       throw Object.assign(new Error("This patient is no longer waiting for vitals"), {
  515 |         status: 409,
  516 |       });
  517 |     const movedTo = await moveOnFromVitals(client, visitId, actorId, {
  518 |       vitals: null,
  519 |       vitalsNotTaken: true,
  520 |       vitalsNotTakenReason: reason,
  521 |     });
  522 |     await client.query("COMMIT");
  523 |     return { movedTo };
  524 |   } catch (e) {
  525 |     await client.query("ROLLBACK");
  526 |     throw e;
  527 |   } finally {
  528 |     client.release();
  529 |   }
  530 | }
  531 | 
  532 | export async function saveVitals(
  533 |   visitId,
  534 |   {
  535 |     weight,
  536 |     height,
  537 |     bpSys,
  538 |     bpDia,
  539 |     bpStandingSys,
  540 |     bpStandingDia,
  541 |     waist,
  542 |     bodyFat,
  543 |     pulse,
  544 |     spo2,
  545 |     temp,
  546 |     source = "manual",
  547 |     actorId = null,
  548 |   },
  549 |   db = pool,
  550 | ) {
  551 |   const client = await db.connect();
  552 |   try {
  553 |     await client.query("BEGIN");
  554 | 
  555 |     const visit = await client.query(
  556 |       `SELECT patient_id, current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
  557 |       [visitId],
  558 |     );
  559 |     if (!visit.rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  560 |     await refuseWhileResting(client, visitId);
  561 |     if (NOT_STARTED_STATUSES.includes(visit.rows[0].current_status))
  562 |       throw Object.assign(
  563 |         new Error("Call this patient to the station before recording their vitals"),
  564 |         { status: 409 },
  565 |       );
  566 | 
  567 |     // A save with nothing in it recorded a row of nulls and moved the patient to
  568 |     // `vitals_done` — the board showed vitals complete, the MO's brief showed
  569 |     // "Vitals just taken" with nothing under it, and the vitals budget measured
  570 |     // a station that took no reading. All three vitals rows on record are this.
  571 |     if (
  572 |       [
  573 |         weight,
  574 |         height,
  575 |         bpSys,
  576 |         bpDia,
  577 |         bpStandingSys,
  578 |         bpStandingDia,
  579 |         waist,
  580 |         bodyFat,
  581 |         pulse,
  582 |         spo2,
  583 |         temp,
  584 |       ].every((v) => v === null || v === undefined)
  585 |     )
```