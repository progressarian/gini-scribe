# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: G127-arrived-for-appointment.spec.js >> G127 a lab-only patient who is then sent to a consultant >> 1. the lab booking edited to a consultant shows Arrived for appointment and adds the consultation after the lab
- Location: e2e/giniflow/G127-arrived-for-appointment.spec.js:84:3

# Error details

```
error: relation "deposit_entries" does not exist
```

# Test source

```ts
  451 |   await query(`DELETE FROM payments WHERE bill_id = ANY($1)`, [bills]);
  452 |   await query(
  453 |     `DELETE FROM billing_requests
  454 |       WHERE patient_id = ANY($1) OR visit_id = ANY($2) OR bill_id = ANY($3)
  455 |          OR created_item_id = ANY($4) OR service_item_id = ANY($4)`,
  456 |     [patients, visits, bills, items],
  457 |   );
  458 |   const settlements = await idsOf(
  459 |     `SELECT settlement_id AS id FROM claim_settlement_bills WHERE bill_id = ANY($1)
  460 |      UNION SELECT claim_settlement_id FROM bills
  461 |       WHERE id = ANY($1) AND claim_settlement_id IS NOT NULL
  462 |      UNION SELECT id FROM claim_settlements WHERE payer_name LIKE '% ' || $2`,
  463 |     [bills, tag],
  464 |   );
  465 |   await query(`DELETE FROM claim_settlement_bills WHERE bill_id = ANY($1)`, [bills]);
  466 |   await query(`DELETE FROM bills WHERE id = ANY($1) AND original_bill_id IS NOT NULL`, [bills]);
  467 |   await query(`DELETE FROM bills WHERE id = ANY($1)`, [bills]);
  468 |   await query(
  469 |     `DELETE FROM claim_settlements s WHERE s.id = ANY($1)
  470 |         AND NOT EXISTS (SELECT 1 FROM claim_settlement_bills x WHERE x.settlement_id = s.id)
  471 |         AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.claim_settlement_id = s.id)`,
  472 |     [settlements],
  473 |   );
  474 |   await query(
  475 |     `DELETE FROM lab_cases
  476 |       WHERE patient_id = ANY($1)
  477 |          OR appointment_id IN (SELECT id FROM appointments WHERE patient_id = ANY($1))
  478 |          OR raw_list_json -> 'patient' ->> 'healthray_uid' ~ $2`,
  479 |     [patients, filed],
  480 |   );
  481 |   await query(`DELETE FROM giniflow_lab_orders WHERE visit_id = ANY($1)`, [visits]);
  482 |   await query(`DELETE FROM giniflow_visit_events WHERE visit_id = ANY($1)`, [visits]);
  483 |   await query(`DELETE FROM giniflow_visits WHERE id = ANY($1)`, [visits]);
  484 |   await query(
  485 |     `DELETE FROM appointment_change_log
  486 |       WHERE appointment_id IN (SELECT id FROM appointments WHERE patient_id = ANY($1))`,
  487 |     [patients],
  488 |   ).catch(() => {});
  489 |   await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
  490 |   await query(`DELETE FROM walkin_bookings WHERE patient_id = ANY($1)`, [patients]).catch(() => {});
  491 |   await query(`DELETE FROM documents WHERE patient_id = ANY($1)`, [patients]);
  492 |   await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
  493 |   await query(`UPDATE patients SET scheme_code = NULL WHERE scheme_code LIKE $1`, [schemes]);
  494 |   await query(`DELETE FROM discount_rules WHERE id = ANY($1)`, [rules]);
  495 |   await query(
  496 |     `DELETE FROM category_payment_rules
  497 |       WHERE name LIKE $1 OR scheme_code LIKE $2 OR service_item_id = ANY($3)`,
  498 |     [named, schemes, items],
  499 |   );
  500 |   await query(`DELETE FROM category_item_rates WHERE service_item_id = ANY($1)`, [items]);
  501 |   await query(`DELETE FROM service_items WHERE id = ANY($1)`, [items]);
  502 |   await query(`DELETE FROM giniflow_test_catalog WHERE test_name LIKE $1`, [named]);
  503 |   await query(`DELETE FROM service_subgroups WHERE code = 'P4S-' || $1`, [tag]);
  504 |   await query(`DELETE FROM service_groups WHERE code = 'P4G-' || $1`, [tag]);
  505 |   await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, [schemes]);
  506 |   await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, [schemes]);
  507 | }
  508 | 
  509 | export async function abandonedTags() {
  510 |   const { rows } = await query(
  511 |     `SELECT substring(code FROM $3) AS tag FROM service_groups WHERE code LIKE 'P4G-%'
  512 |      UNION SELECT substring(name FROM $1) FROM patients WHERE name LIKE 'P4 %'
  513 |      UNION SELECT substring(name FROM $1) FROM discount_rules WHERE name LIKE 'P4 %'
  514 |      UNION SELECT substring(code FROM $2) FROM service_items WHERE code LIKE 'P4-%'
  515 |      UNION SELECT substring(code FROM $4) FROM patient_schemes WHERE code LIKE 'p4%'`,
  516 |     [TAG_OF.name, TAG_OF.code, TAG_OF.group, TAG_OF.scheme],
  517 |   );
  518 |   const client = await getPool().connect();
  519 |   try {
  520 |     const abandoned = [];
  521 |     for (const tag of new Set(rows.map((row) => row.tag).filter(Boolean))) {
  522 |       if (!(await isLive(client, tag))) abandoned.push(tag);
  523 |     }
  524 |     return abandoned;
  525 |   } finally {
  526 |     client.release();
  527 |   }
  528 | }
  529 | 
  530 | export async function sweepAbandoned() {
  531 |   for (const tag of await abandonedTags()) await sweep(tag);
  532 | }
  533 | 
  534 | async function releaseSeries(fy) {
  535 |   await query(
  536 |     `DELETE FROM bill_series
  537 |       WHERE fy = $1
  538 |         AND ((series = 'MAIN' AND prefix ~ '^P4[0-9A-F]{6}/$')
  539 |           OR (series = 'RCPT' AND prefix ~ '^R4[0-9A-F]{6}/$')
  540 |           OR (series = 'CN' AND prefix ~ '^C4[0-9A-F]{6}/$'))
  541 |         AND NOT EXISTS (SELECT 1 FROM service_groups WHERE code LIKE 'P4G-%')`,
  542 |     [fy],
  543 |   );
  544 | }
  545 | 
  546 | export async function sweepDeposits(patients, bills = []) {
  547 |   const client = await getPool().connect();
  548 |   try {
  549 |     await client.query("BEGIN");
  550 |     await client.query("SET LOCAL session_replication_role = replica");
> 551 |     await client.query(
      |     ^ error: relation "deposit_entries" does not exist
  552 |       `DELETE FROM deposit_entries WHERE patient_id = ANY($1) OR bill_id = ANY($2)`,
  553 |       [patients, bills],
  554 |     );
  555 |     await client.query(`DELETE FROM payments WHERE deposit_patient_id = ANY($1)`, [patients]);
  556 |     await client.query(`DELETE FROM deposit_accounts WHERE patient_id = ANY($1)`, [patients]);
  557 |     await client.query(
  558 |       `DELETE FROM documents WHERE doc_type = 'deposit_consent' AND patient_id = ANY($1)`,
  559 |       [patients],
  560 |     );
  561 |     await client.query("COMMIT");
  562 |   } catch (error) {
  563 |     await client.query("ROLLBACK").catch(() => {});
  564 |     throw error;
  565 |   } finally {
  566 |     client.release();
  567 |   }
  568 | }
  569 | 
  570 | export async function tearDown(ids) {
  571 |   if (!ids?.tag) return;
  572 |   try {
  573 |     await sweep(ids.tag);
  574 |     if (ids.fy) await releaseSeries(ids.fy);
  575 |   } finally {
  576 |     await releaseTag(ids.tag);
  577 |   }
  578 | }
  579 | 
```