import pool from "../../config/db.js";
import {
  CHAIN,
  STATUS_LABEL,
  chainIndex,
  isChainStatus,
  isTerminalStatus,
} from "../../../shared/giniflowStatus.js";
import { advanceStatus } from "./statusEngine.js";
import { genVisitToken } from "../flow/journey.js";

// The journey reception builds when a patient arrives — what this patient is
// here for, in the order they will do it.
// docs/gini-flow/29-RECEPTION-JOURNEY-PLAN.md
//
// The reference data belongs to the /flow module (visit types, step catalog,
// per-type templates, staff) and stays there: one catalog to edit, not two. What
// lives here is the per-visit plan.
//
// The plan PLANS AND SHOWS. It does not route: the board's columns and every
// station's buttons work exactly as they did. What the plan gives is the stops
// this patient will make, who is expected to do them, what that should take, and
// — through the auto-tick below — where they have got to.

const STEP_SELECT = `
  SELECT id, visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
         station, assigned_role, assigned_staff_id, assigned_staff_name,
         chain_status, status, started_at, completed_at, source
    FROM giniflow_visit_steps`;

const shapeStep = (r) => ({
  stepId: r.id,
  order: r.step_order,
  catalogId: r.step_catalog_id,
  name: r.step_name,
  minutes: r.planned_duration_min,
  station: r.station,
  role: r.assigned_role,
  staffId: r.assigned_staff_id,
  staffName: r.assigned_staff_name,
  chainStatus: r.chain_status,
  status: r.status,
  // A step with no board column is one nobody else can complete — the screens
  // show a tick for exactly these.
  manual: !r.chain_status,
  startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  source: r.source,
});

const clampMinutes = (v) => Math.min(600, Math.max(0, Math.round(Number(v) || 0)));

const trimmed = (v, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

// ── Reference data → an editable plan ──────────────────────────────────────

// The type's template, shaped for the builder. is_optional / condition_key are
// carried through rather than flattened: the templates already encode which
// steps are a choice, and dropping that would quietly make every journey the
// maximal one.
export async function defaultPlan(visitTypeId, db = pool) {
  const { rows } = await db.query(
    `SELECT t.step_order, t.is_default, t.is_optional, t.condition_key,
            c.id AS catalog_id, c.name, c.station, c.assigned_role, c.chain_status,
            COALESCE(t.override_duration_min, c.default_duration_min)::int AS minutes
       FROM flow_step_templates t
       JOIN flow_step_catalog c ON c.id = t.step_catalog_id
      WHERE t.visit_type_id = $1 AND COALESCE(c.is_active, TRUE)
        -- The lab's own pipeline — delivered / processing / reports available,
        -- and the report desk's stages — is not a stop the patient makes. The
        -- lab station records that work already, and listing it here asked the
        -- desk to tick seven boxes for things they never touch. A background
        -- step that DOES map to a board column (the MO preparing a prescription)
        -- stays: it ticks itself and costs nobody anything.
        AND NOT (COALESCE(c.is_background, FALSE) AND c.chain_status IS NULL)
      ORDER BY t.step_order`,
    [visitTypeId],
  );
  return rows.map((r) => ({
    catalogId: r.catalog_id,
    name: r.name,
    minutes: r.minutes,
    station: r.station,
    role: r.assigned_role,
    chainStatus: r.chain_status,
    optional: !!r.is_optional,
    conditionKey: r.condition_key,
    // An optional step is offered unticked; everything else starts included.
    included: r.is_default !== false && !r.is_optional,
    source: "template",
  }));
}

// Which visit type to preselect. Data, not a hardcoded id: the flags live on
// flow_visit_types and an admin can move them. No match — an unflagged type like
// ONLINE, or a floor that has not filled the flags in — means no preselection,
// and reception picks. A type with no template rows is also fine: the builder
// opens empty and they add what the patient needs.
export async function suggestVisitType({ isFollowUp, isWalkIn, isTests = false }, db = pool) {
  const { rows } = await db.query(
    `SELECT id FROM flow_visit_types
      WHERE for_followup = $1 AND for_walkin = $2
        AND COALESCE(for_tests, FALSE) = $3
      ORDER BY max_time_min, id LIMIT 1`,
    [!!isFollowUp, !!isWalkIn, !!isTests],
  );
  return rows[0]?.id || null;
}

// ── Reading a journey ──────────────────────────────────────────────────────

export async function getJourney(visitId, db = pool) {
  const { rows } = await db.query(`${STEP_SELECT} WHERE visit_id = $1 ORDER BY step_order`, [
    visitId,
  ]);
  const steps = rows.map(shapeStep);
  const done = steps.filter((s) => s.status === "done").length;
  const current = steps.find((s) => s.status === "in_progress") || null;
  const next = steps.find((s) => s.status === "pending") || null;
  return {
    visitId,
    steps,
    doneCount: done,
    totalCount: steps.length,
    plannedTotalMin: steps.reduce((sum, s) => sum + s.minutes, 0),
    currentStep: current?.name || null,
    nextStep: next?.name || null,
  };
}

// ── Writing one ────────────────────────────────────────────────────────────

const insertSteps = async (client, visitId, steps) => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await client.query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
          station, assigned_role, assigned_staff_id, assigned_staff_name,
          chain_status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               -- The catalog's mapping is snapshotted here, and a custom step
               -- has none: it is a stop nobody's board was built to show.
               (SELECT chain_status FROM flow_step_catalog WHERE id = $3),
               $10)`,
      [
        visitId,
        i + 1,
        s.catalogId || null,
        trimmed(s.name) || "Step",
        clampMinutes(s.minutes),
        trimmed(s.station) || null,
        trimmed(s.role, 60) || null,
        s.staffId ? String(s.staffId).slice(0, 40) : null,
        trimmed(s.staffName) || null,
        s.catalogId ? s.source || "template" : "custom",
      ],
    );
  }
};

const uniqueToken = async (client) => {
  for (let i = 0; i < 5; i++) {
    const token = genVisitToken();
    const hit = await client.query(`SELECT 1 FROM giniflow_visits WHERE visit_token = $1`, [token]);
    if (!hit.rowCount) return token;
  }
  return genVisitToken();
};

// Reception's arrival, in one transaction: the status the board reads, the plan
// the floor and the patient read, and the token the patient's link needs. The
// WhatsApp is the caller's job, AFTER the commit — a message that fails must
// never cost the check-in.
export async function checkInWithJourney(
  visitId,
  { visitTypeId = null, steps = [], actorId = null, actorRole = "reception" },
  db = pool,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT v.current_status,
              (SELECT count(*)::int FROM giniflow_visit_steps s WHERE s.visit_id = v.id) AS steps
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!existing.rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const current = existing.rows[0].current_status;
    // A second press at a busy counter must not give the patient two journeys.
    const alreadyPlanned = existing.rows[0].steps > 0;
    const alreadyHere = isChainStatus(current) && chainIndex(current) >= chainIndex("checked_in");

    // Someone already down the floor is not arriving again — the same refusal
    // the Arrived button has always given. A patient standing AT the desk whose
    // status is already checked_in is the double-tap: no second event, but the
    // journey they were being given is still attached.
    if (isChainStatus(current) && chainIndex(current) > chainIndex("checked_in")) {
      throw Object.assign(
        new Error(`${STATUS_LABEL[current] || current} — this patient is already past reception`),
        { status: 409 },
      );
    }

    if (!alreadyHere) {
      await advanceStatus(client, {
        visitId,
        toStatus: "checked_in",
        actorRole,
        actorId,
        meta: { visitTypeId, steps: steps.length },
      });
    }

    if (!alreadyPlanned) {
      await insertSteps(client, visitId, steps);
      // A plan attached to a patient who is already here has to agree with where
      // they are, the same way a seeded one does.
      if (alreadyHere) await syncFromStatus(client, visitId, current);
    }

    // Assigning a doctor on the journey has to mean what it looks like it
    // means: the consultant's own queue reads giniflow_visits, not the steps.
    // Read back from the rows just written, so the catalog's mapping decides
    // which column a name belongs in rather than anything the client sent.
    const assigned = await client.query(
      `SELECT chain_status, assigned_staff_id::int AS staff_id
         FROM giniflow_visit_steps
        WHERE visit_id = $1
          AND chain_status IN ('with_sd', 'with_doctor')
          AND assigned_staff_id ~ '^[0-9]+$'
        ORDER BY step_order`,
      [visitId],
    );
    const forColumn = (status) =>
      assigned.rows.find((r) => r.chain_status === status)?.staff_id ?? null;

    const token = await uniqueToken(client);
    const planned = steps.reduce((sum, s) => sum + clampMinutes(s.minutes), 0);
    await client.query(
      `UPDATE giniflow_visits
          SET visit_type_id = COALESCE($2, visit_type_id),
              planned_total_min = CASE WHEN $4 THEN planned_total_min ELSE $3 END,
              visit_token = COALESCE(visit_token, $5),
              checked_in_by = COALESCE(checked_in_by, $6),
              -- COALESCE, never an overwrite: the module's existing rule is that
              -- whoever is in the room beats whoever was booked, and by the time
              -- a station has claimed a patient the desk's guess is stale.
              assigned_sd_id = COALESCE(assigned_sd_id, $7),
              assigned_doctor_id = COALESCE(assigned_doctor_id, $8),
              updated_at = NOW()
        WHERE id = $1`,
      [
        visitId,
        visitTypeId,
        planned,
        alreadyPlanned,
        token,
        actorId,
        forColumn("with_sd"),
        forColumn("with_doctor"),
      ],
    );
    await client.query("COMMIT");
    const journey = await getJourney(visitId, db);
    const { rows } = await db.query(
      `SELECT visit_token, planned_total_min FROM giniflow_visits WHERE id = $1`,
      [visitId],
    );
    return {
      ...journey,
      alreadyPlanned,
      visitToken: rows[0]?.visit_token || null,
      plannedTotalMin: rows[0]?.planned_total_min ?? journey.plannedTotalMin,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Most patients on this floor are checked in by the HealthRay sync, which knows
// nothing about this screen. Without a plan seeded for them the journey would be
// a feature only the patients reception happened to press a button for ever got.
export async function ensurePlan(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.visit_type_id, v.current_status,
            -- Completed bookings only, and never appointments.is_walkin — the
            -- reasons are on ARRIVAL_SELECT in receptionStation.js, with the
            -- numbers in src/lib/flowAppointmentType.js.
            (SELECT COUNT(*)::int FROM appointments pa
              WHERE pa.patient_id = v.patient_id
                AND pa.appointment_date < v.visit_date
                AND pa.status = 'completed') AS prior_visits,
            CASE
              WHEN a.visit_type ~* '(follow|f/?u|review)' THEN TRUE
              WHEN a.visit_type ~* '^\s*new\b' THEN FALSE
              ELSE NULL
            END AS booked_as_followup,
            (a.visit_type ~* '(investigat|lab|test)') AS booked_for_tests,
            (SELECT COUNT(*)::int FROM giniflow_visit_steps s WHERE s.visit_id = v.id) AS steps
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [visitId],
  );
  const visit = rows[0];
  if (!visit) throw Object.assign(new Error("Visit not found"), { status: 404 });
  if (visit.steps > 0) return { seeded: false };

  const visitTypeId =
    visit.visit_type_id ||
    (await suggestVisitType(
      {
        isFollowUp: visit.booked_as_followup ?? visit.prior_visits > 0,
        isWalkIn: false,
        isTests: !!visit.booked_for_tests,
      },
      db,
    ));
  if (!visitTypeId) return { seeded: false };

  const plan = (await defaultPlan(visitTypeId, db)).filter((s) => s.included);
  if (!plan.length) return { seeded: false };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Two screens opening the same patient at once both saw zero steps above.
    // Without the lock and this second look they would both insert orders
    // 1..N and collide on the unique key, turning a plain read into a 500.
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const race = await client.query(
      `SELECT count(*)::int AS c FROM giniflow_visit_steps WHERE visit_id = $1`,
      [visitId],
    );
    if (race.rows[0].c > 0) {
      await client.query("COMMIT");
      return { seeded: false };
    }
    await insertSteps(
      client,
      visitId,
      plan.map((s) => ({ ...s, source: "auto" })),
    );
    await client.query(
      `UPDATE giniflow_visits
          SET visit_type_id = COALESCE(visit_type_id, $2),
              planned_total_min = COALESCE(planned_total_min, $3)
        WHERE id = $1`,
      [visitId, visitTypeId, plan.reduce((sum, s) => sum + s.minutes, 0)],
    );
    // The patient may already be halfway down the floor, so the plan they were
    // given retrospectively has to agree with where they actually are.
    await syncFromStatus(client, visitId, visit.current_status);
    await client.query("COMMIT");
    return { seeded: true, visitTypeId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── The auto-tick ──────────────────────────────────────────────────────────

// A visit that ended because the patient LEFT, not because they finished. The
// difference matters to the plan: someone who walked out did none of it, while
// someone who exited did all the stops the board can see.
const ABANDONED = ["cancelled", "no_show"];

// Called from inside advanceStatus, so it lands in the same transaction as the
// status change and cannot drift from it.
//
// It runs on EVERY station action in the module, so it is deliberately three
// plain UPDATEs against its own table — no inserts, no foreign keys, nothing
// that can raise and take a nurse's "vitals done" down with it. A visit with no
// plan matches no rows and costs one cheap statement.
export async function syncFromStatus(client, visitId, toStatus) {
  if (ABANDONED.includes(toStatus)) {
    // Never 'done': the tracker must not claim an X-Ray happened because the
    // patient went home.
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'skipped'
        WHERE visit_id = $1 AND status IN ('pending', 'in_progress')`,
      [visitId],
    );
    return;
  }
  if (!isChainStatus(toStatus)) return;

  const reached = chainIndex(toStatus);
  const behind = CHAIN.filter((s) => chainIndex(s) < reached);

  // Everything the patient has passed is done — "at or behind", not "equal", so
  // a status the floor skipped (allowSkip) cannot strand a step as pending.
  if (behind.length) {
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'done',
              started_at = COALESCE(started_at, NOW()),
              completed_at = COALESCE(completed_at, NOW())
        WHERE visit_id = $1 AND chain_status = ANY($2::text[])
          AND status IN ('pending', 'in_progress')`,
      [visitId, behind],
    );
  }

  // Where they are now. Several steps can share one column — an SD consultation
  // and a chief consultation are two stops in one — so the earliest unfinished
  // one is the live step and the rest wait their turn.
  await client.query(
    `UPDATE giniflow_visit_steps
        SET status = 'in_progress',
            started_at = COALESCE(started_at, NOW()),
            completed_at = NULL
      WHERE id = (
        SELECT id FROM giniflow_visit_steps
         WHERE visit_id = $1 AND chain_status = $2
           -- 'done' as well as 'pending': a consultant who steps out sends the
           -- patient back to a station they had left, and the plan has to be
           -- able to walk backwards with them.
           AND status IN ('pending', 'done')
         ORDER BY step_order LIMIT 1
      )`,
    [visitId, toStatus],
  );

  // The patient has left the building having done everything the board could
  // see — the rule above has already completed those. What can still be pending
  // is a stop with no column that nobody ticked, and that one was genuinely not
  // done. Ordering matters: skipping first would strike through the pharmacy
  // stop of every patient who finished properly.
  if (toStatus === "exited") {
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'skipped'
        WHERE visit_id = $1 AND status IN ('pending', 'in_progress')`,
      [visitId],
    );
  }
}

// ── Editing a journey that is already on the floor ─────────────────────────

export async function setStepStatus(stepId, status, db = pool) {
  if (!["pending", "in_progress", "done", "skipped"].includes(status)) {
    throw Object.assign(new Error("Unknown step status"), { status: 400 });
  }

  // A stop only becomes tickable when the ones before it are finished. Billing
  // sits seventh of eight in every template, and a tick available from check-in
  // let a patient be marked billed before they had seen the doctor.
  //
  // Enforced here as well as hidden on the screen: a hidden button is not a
  // rule, and this one decides whether a patient's record says they paid.
  // Undoing is never blocked — a mis-tick has to be correctable.
  if (status === "done") {
    const { rows: earlier } = await db.query(
      `SELECT prev.step_name
         FROM giniflow_visit_steps s
         JOIN giniflow_visit_steps prev
           ON prev.visit_id = s.visit_id AND prev.step_order < s.step_order
        WHERE s.id = $1 AND prev.status NOT IN ('done', 'skipped')
          -- Only what the TEMPLATE laid out is a sequence. A stop the desk added
          -- during the visit is appended to the end of the list but happened
          -- now, and holding it until the pharmacy had been done would make it
          -- untickable for the whole visit.
          AND s.source IN ('template', 'auto')
        ORDER BY prev.step_order LIMIT 1`,
      [stepId],
    );
    if (earlier.length) {
      throw Object.assign(
        new Error(`${earlier[0].step_name} comes first — this stop is not due yet`),
        { status: 409 },
      );
    }
  }

  const { rows } = await db.query(
    `UPDATE giniflow_visit_steps
        SET status = $2,
            started_at = CASE
              WHEN $2 IN ('in_progress', 'done') THEN COALESCE(started_at, NOW())
              ELSE started_at END,
            completed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE NULL END
      WHERE id = $1 RETURNING visit_id`,
    [stepId, status],
  );
  if (!rows.length) throw Object.assign(new Error("Step not found"), { status: 404 });
  return getJourney(rows[0].visit_id, db);
}

export async function addStep(visitId, step, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // The visit is the lock for its own journey: two people adding a stop at the
    // same moment would otherwise both take MAX+1 and one would fail.
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(step_order), 0) AS last FROM giniflow_visit_steps WHERE visit_id = $1`,
      [visitId],
    );
    await client.query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
          station, assigned_role, assigned_staff_id, assigned_staff_name, chain_status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               (SELECT chain_status FROM flow_step_catalog WHERE id = $3), $10)`,
      [
        visitId,
        rows[0].last + 1,
        step.catalogId || null,
        trimmed(step.name) || "Step",
        clampMinutes(step.minutes),
        trimmed(step.station) || null,
        trimmed(step.role, 60) || null,
        step.staffId ? String(step.staffId).slice(0, 40) : null,
        trimmed(step.staffName) || null,
        step.catalogId ? "added" : "custom",
      ],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getJourney(visitId, db);
}

export async function removeStep(stepId, db = pool) {
  const { rows } = await db.query(
    `DELETE FROM giniflow_visit_steps WHERE id = $1 RETURNING visit_id`,
    [stepId],
  );
  if (!rows.length) throw Object.assign(new Error("Step not found"), { status: 404 });
  return getJourney(rows[0].visit_id, db);
}

// The order arrives as the full list of step ids. Renumbering inside one
// transaction is what the deferrable unique key on (visit_id, step_order) is for.
export async function reorderSteps(visitId, stepIds, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    // A list that is missing a step — someone else added one while this screen
    // was open — would renumber around it and collide at COMMIT, losing the
    // whole reorder. Refused up front, with the reason.
    const { rows } = await client.query(
      `SELECT count(*)::int AS c FROM giniflow_visit_steps WHERE visit_id = $1`,
      [visitId],
    );
    if (rows[0].c !== stepIds.length) {
      throw Object.assign(
        new Error("This journey changed while you were reordering it — reopen it and try again"),
        { status: 409 },
      );
    }
    await client.query(`SET CONSTRAINTS giniflow_visit_steps_order DEFERRED`);
    for (let i = 0; i < stepIds.length; i++) {
      await client.query(
        `UPDATE giniflow_visit_steps SET step_order = $3 WHERE id = $1 AND visit_id = $2`,
        [stepIds[i], visitId, i + 1],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getJourney(visitId, db);
}

// ── The patient's own view ─────────────────────────────────────────────────

// Same shape the /flow tracker returns, so one public page serves both modules.
// Everything here is visible to anyone holding the link, so it carries a first
// name and nothing else that identifies the patient.
export async function trackByToken(token, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.current_status, v.planned_total_min, p.name,
            checkin.occurred_at AS checked_in_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = 'checked_in'
          ORDER BY occurred_at LIMIT 1
       ) checkin ON TRUE
      WHERE v.visit_token = $1`,
    [token],
  );
  const visit = rows[0];
  if (!visit) return null;

  const { steps, doneCount, totalCount, currentStep } = await getJourney(visit.id, db);
  const planned = visit.planned_total_min || 0;
  const elapsed = visit.checked_in_at
    ? Math.max(0, Math.round((Date.now() - new Date(visit.checked_in_at).getTime()) / 60000))
    : 0;
  return {
    first_name: (visit.name || "").split(" ")[0],
    status: visit.current_status,
    current_step: currentStep,
    step_index: currentStep ? doneCount + 1 : doneCount,
    total_steps: totalCount,
    // dispensed as well as exited: the board calls both terminal, and a patient
    // holding their medicines should not be shown a countdown.
    remaining_min:
      isTerminalStatus(visit.current_status) || ABANDONED.includes(visit.current_status)
        ? 0
        : Math.max(0, planned - elapsed),
    timeline: steps.map((s) => ({ name: s.name, status: s.status })),
  };
}
