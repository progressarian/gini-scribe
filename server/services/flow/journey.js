// Pure helpers for the Patient Flow module — timing math, urgency
// classification, token generation, and the step state-machine rules.
// Single source of truth for the amber/red thresholds (plan §2, §4.1).

import crypto from "crypto";

// Waiting-area steps (wait_sd / wait_chief) are assigned to this role. A
// waiting "station" is never busy — any number of patients can be waiting at
// once — so it never blocks an auto-start.
export const WAITING_ROLE = "flow_coordinator";

// Step-budget overage thresholds (minutes) → colour.
const STEP_AMBER_OVER = 5;
const STEP_RED_OVER = 10;
// Visit elapsed thresholds (% of max) → row colour.
const VISIT_ATRISK_PCT = 80;

// 12-char URL-safe-ish token for the patient tracking link.
export function genVisitToken() {
  return crypto.randomBytes(6).toString("hex");
}

const ms = (t) => (t ? new Date(t).getTime() : null);
const minsBetween = (a, b) => Math.max(0, Math.round((b - a) / 60000));

// Visit-level timing + urgency. `now` is injected for testability.
export function classifyVisit(visit, now = Date.now()) {
  const checkin = ms(visit.checkin_time);
  const end = visit.actual_completion ? ms(visit.actual_completion) : now;
  const max = visit.max_time_min || 0;
  const elapsed = checkin ? minsBetween(checkin, end) : 0;
  const remaining = max - elapsed;
  const pct = max > 0 ? Math.round((elapsed / max) * 100) : 0;

  let urgency = "ok";
  if (visit.status === "completed") {
    urgency = elapsed <= max ? "done_ok" : "done_over";
  } else if (visit.status === "cancelled") {
    urgency = "cancelled";
  } else if (elapsed >= max) {
    urgency = "breach";
  } else if (pct >= VISIT_ATRISK_PCT) {
    urgency = "atrisk";
  }
  return { elapsed_min: elapsed, remaining_min: remaining, pct_elapsed: pct, urgency };
}

// Step-level timing + colour for the in-progress step (drives "Wait SD ⚠ 32m").
export function classifyStep(step, now = Date.now()) {
  if (step.status !== "in_progress" || !step.started_at) {
    return { at_station_min: null, over_min: 0, colour: "grey" };
  }
  const atStation = minsBetween(ms(step.started_at), now);
  const over = atStation - (step.planned_duration_min || 0);
  let colour = "green";
  if (over > STEP_RED_OVER) colour = "red";
  else if (over > STEP_AMBER_OVER) colour = "amber";
  return { at_station_min: atStation, over_min: over, colour };
}

// Sort comparator for the coordinator dashboard: breach first, then VIP ahead
// of same-urgency non-VIP, then by remaining/max ascending (plan §6.2).
// Completed/cancelled sink to the bottom.
const URGENCY_RANK = { breach: 0, atrisk: 1, ok: 2, done_ok: 8, done_over: 8, cancelled: 9 };
export function compareVisitsForDashboard(a, b) {
  const ra = URGENCY_RANK[a._timing.urgency] ?? 5;
  const rb = URGENCY_RANK[b._timing.urgency] ?? 5;
  if (ra !== rb) return ra - rb;
  if (!!b.is_vip !== !!a.is_vip) return b.is_vip ? 1 : -1;
  const fa = a.max_time_min ? a._timing.remaining_min / a.max_time_min : 1;
  const fb = b.max_time_min ? b._timing.remaining_min / b.max_time_min : 1;
  return fa - fb;
}

// The current bottleneck message for a visit, if its active step is overdue.
export function bottleneckFor(steps, now = Date.now()) {
  const active = steps.find((s) => s.status === "in_progress");
  if (!active) return null;
  const c = classifyStep(active, now);
  if (c.colour === "green") return null;
  return {
    step_name: active.step_name,
    at_station_min: c.at_station_min,
    planned_duration_min: active.planned_duration_min,
    over_min: c.over_min,
    colour: c.colour,
  };
}
