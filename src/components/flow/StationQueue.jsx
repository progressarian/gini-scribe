import { useEffect, useState } from "react";
import { toast } from "../../stores/uiStore";
import {
  useFlowQueue,
  useFlowAdvance,
  useFlowStartStep,
  useFlowVisits,
  useFlowStepCatalog,
  useFlowAddStep,
  useFlowRemoveStep,
  useFlowClaimStep,
  useFlowReleaseStep,
} from "../../queries/hooks/useFlow";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES as CAP, hasCapability, ownsStationRole } from "../../../shared/permissions";
import "../../styles/flow.css";

// Friendly URL slug → the assigned_role stored on flow_visit_steps, plus the
// station's display title and which data-entry form to render. Shared by the
// standalone station page and the "Live Lab Queue" tab on /lab-requests.
export const ROLES = {
  vitals: { role: "vitals_associate", title: "⚖️ Vitals Station", form: "vitals" },
  mo: { role: "mo", title: "🩺 Doctor", form: "notes" },
  lab: { role: "lab_tech", title: "🔬 Lab & Tests", form: "lab" },
  dietitian: { role: "dietitian", title: "🥗 Dietitian", form: "notes" },
  rx: { role: "nurse", title: "💬 Prescription Explain", form: "rx" },
  pharmacy: { role: "pharmacist", title: "💊 Pharmacy — Final Step", form: "pharmacy" },
};

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Quick-pick reasons for skipping a step (free text still allowed). Mirrors the
// list in VisitDetailModal so skip reasons stay consistent across the app.
const SKIP_REASONS = ["Already done", "Not required", "Done elsewhere", "Patient declined"];

// Patients still in the building — a completed or cancelled visit has left, so
// it would only add noise to a live station screen.
const PRESENT_STATUSES = ["waiting", "paused", "in_progress"];
const VISIT_STATUS_LABEL = {
  waiting: "waiting — timer not started",
  paused: "paused",
  in_progress: "in progress",
};

// Where a patient is right now: the step being worked, else the next one open.
const currentStepOf = (v) => {
  const steps = (v.steps || []).slice().sort((a, b) => a.step_order - b.step_order);
  return (
    steps.find((s) => s.status === "in_progress") ||
    steps.find((s) => ["ready", "pending"].includes(s.status)) ||
    null
  );
};

// The live execution queue for one station role: the active (in-progress)
// patient with a role-specific form + "advance", and one call-in queue holding
// every step assigned here. Self-contained (owns its data + mutations) so it
// can be dropped into any page.
export default function StationQueue({ role, form, freeMove = false }) {
  const { data, isLoading } = useFlowQueue(role);
  const advance = useFlowAdvance();
  const startStep = useFlowStartStep();
  const addStep = useFlowAddStep();
  const removeStep = useFlowRemoveStep();
  const claimStep = useFlowClaimStep();
  const releaseStep = useFlowReleaseStep();
  // Server-side floor search (name / file / phone / token), debounced so a
  // desk can find any patient today without scrolling the whole floor.
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const searching = debounced.length > 0;

  const { data: allVisits = [], isFetching: searchBusy } = useFlowVisits(
    undefined,
    undefined,
    {},
    debounced,
  );
  const { data: catalog = [] } = useFlowStepCatalog();
  const myRole = useAuthStore((st) => st.currentDoctor?.role);
  const myId = useAuthStore((st) => st.currentDoctor?.id);
  const heldByMe = (s) => s.claim && String(s.claim.by_id) === String(myId);
  const heldByOther = (s) => s.claim && String(s.claim.by_id) !== String(myId);
  const canManage = hasCapability(myRole, CAP.FLOW_COORDINATOR);
  // Journey edits confined to this desk: floor managers anywhere, station staff
  // only where they actually work.
  const canEditHere = canManage || ownsStationRole(myRole, role);

  const active = data?.active?.[0] || null;
  // Callable and not-yet-reachable steps sit in one list: POST /flow/steps/:id/
  // start accepts a pending step, so the desk can pull a patient forward instead
  // of waiting for an earlier station to release them. VIP first, then arrival.
  const ready = [...(data?.ready || []), ...(data?.pending || [])].sort(
    (a, b) =>
      Number(!!b.is_vip) - Number(!!a.is_vip) ||
      new Date(a.checkin_time) - new Date(b.checkin_time),
  );

  // In free-move stations (vitals) the user picks who sits in the form box. The
  // box patient is a LOCAL selection (default: whoever is in_progress, else
  // none); clicking "Move in" on a queued patient just swaps them into the box
  // (and the previous one returns to the list) — it does NOT advance anyone.
  const [selectedId, setSelectedId] = useState(null);
  const queueItems = freeMove ? [...(data?.active || []), ...ready] : [];
  const boxPatient = freeMove ? queueItems.find((i) => i.id === selectedId) || active : active;
  const listItems = freeMove ? queueItems.filter((i) => i.id !== boxPatient?.id) : ready;

  const [formData, setFormData] = useState({});
  useEffect(() => setFormData({}), [boxPatient?.id]);

  // Skip-reason dialog — targets a specific step (the box patient OR any queued
  // patient), so anyone can be skipped at any time. Replaces the native prompt.
  const [skipTarget, setSkipTarget] = useState(null);
  const [skipReason, setSkipReason] = useState("");
  // Remove a step from the patient's journey — the undo for "Send to my
  // station", and for a step queued here that shouldn't be.
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeReason, setRemoveReason] = useState("");

  // Everyone still in the building who isn't already somewhere in this
  // station's own queue (active / ready / queued-behind-an-earlier-step).
  const myVisitIds = new Set([...(data?.active || []), ...ready].map((i) => i.visit_id));
  // Already dealt with here — their step at this station is completed, or was
  // deliberately skipped. Either way this desk is done with them, so they drop
  // off the list rather than looking like outstanding work.
  const settledHere = (v) =>
    (v.steps || []).some(
      (s) => s.assigned_role === role && ["completed", "skipped"].includes(s.status),
    );
  // While searching, show every match the server returned — including patients
  // this desk has already finished with, since finding them again is the point.
  const notSeenHere = (
    searching
      ? allVisits
      : allVisits.filter(
          (v) => PRESENT_STATUSES.includes(v.status) && !myVisitIds.has(v.id) && !settledHere(v),
        )
  ).map((v) => ({ visit: v, step: currentStepOf(v) }));

  // Catalog steps this station works — used to append one for a patient who
  // never got a step here (or whose step is already done). Several stations own
  // more than one (lab: Blood Sample / ABI / X-Ray), so the user picks.
  const myCatalogSteps = catalog.filter((c) => c.assigned_role === role);

  const sendToMyStation = async (v, catId) => {
    const c = myCatalogSteps.find((x) => x.id === catId) || myCatalogSteps[0];
    if (!c) return;
    const maxOrder = (v.steps || []).reduce((m, s) => Math.max(m, s.step_order || 0), 0);
    try {
      await addStep.mutateAsync({
        visitId: v.id,
        step_catalog_id: c.id,
        step_name: c.name,
        planned_duration_min: c.default_duration_min,
        station: c.station,
        assigned_role: c.assigned_role,
        insert_after_order: maxOrder,
      });
      toast(`${v.patient_name} → ${c.name} added to this station's queue`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const callIn = async (stepId) => {
    try {
      await startStep.mutateAsync(stepId);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Bring a queued patient into the form box. Takes the step first, so two
  // people at the same desk can't quietly work the same patient — the loser is
  // told who has them rather than finding out at "Done".
  const moveIntoBox = async (s) => {
    if (heldByOther(s)) {
      toast(`${s.claim.by} is already working ${s.patient_name}`, "warn");
      return;
    }
    try {
      await claimStep.mutateAsync(s.id);
      setSelectedId(s.id);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Hand a patient back to the queue without completing them.
  const release = async (s) => {
    try {
      await releaseStep.mutateAsync(s.id);
      if (selectedId === s.id) setSelectedId(null);
      toast(`${s.patient_name} released back to the queue`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const complete = async () => {
    if (!boxPatient) return;
    try {
      await advance.mutateAsync({
        visitId: boxPatient.visit_id,
        step_id: boxPatient.id,
        step_data: formData,
      });
      toast(`${boxPatient.patient_name} → next step`, "success");
      setFormData({});
      setSelectedId(null);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Skip a step (e.g. vitals already taken elsewhere / not applicable) — the
  // patient still advances. Confirmed via a dialog with quick-pick reasons.
  const confirmSkip = async () => {
    if (!skipTarget) return;
    try {
      await advance.mutateAsync({
        visitId: skipTarget.visit_id,
        step_id: skipTarget.id,
        skip: true,
        reason: skipReason.trim(),
      });
      toast(`${skipTarget.patient_name} — ${skipTarget.step_name} skipped → next step`, "success");
      if (skipTarget.id === boxPatient?.id) {
        setFormData({});
        setSelectedId(null);
      }
      setSkipTarget(null);
      setSkipReason("");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await removeStep.mutateAsync({ stepId: removeTarget.id, reason: removeReason.trim() });
      toast(`${removeTarget.patient_name} — ${removeTarget.step_name} removed`, "success");
      if (removeTarget.id === boxPatient?.id) {
        setFormData({});
        setSelectedId(null);
      }
      setRemoveTarget(null);
      setRemoveReason("");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  if (isLoading) return <div className="flow-card flow-empty">Loading…</div>;

  return (
    <>
      {/* Patient in the form box */}
      {boxPatient ? (
        <div className="station-active">
          <div className="station-head">
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {boxPatient.token_number ? `#${boxPatient.token_number} · ` : ""}
                {boxPatient.patient_name} · Step {boxPatient.step_order} of {boxPatient.total_steps}
              </div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                {boxPatient.patient_age_sex || ""} · {boxPatient.file_no} ·{" "}
                {boxPatient.visit_type_id} · budget ≤ {boxPatient.planned_duration_min} min
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 14 }}>
                At station: {boxPatient.step_timing?.at_station_min ?? 0} min
              </div>
              <div style={{ fontSize: 10, opacity: 0.8 }}>
                Visit: {boxPatient.visit_remaining_min}m left
              </div>
              {boxPatient.claim && (
                <div style={{ fontSize: 10, opacity: 0.9, marginTop: 2 }}>
                  🔒{" "}
                  {heldByMe(boxPatient) ? "you have this patient" : `with ${boxPatient.claim.by}`}
                </div>
              )}
            </div>
          </div>
          <div className="station-body">
            <StationForm key={boxPatient.id} form={form} value={formData} onChange={setFormData} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <button
                className={`flow-btn ${form === "pharmacy" ? "flow-btn-primary" : "flow-btn-grn"}`}
                style={{ padding: "8px 18px" }}
                disabled={advance.isPending || heldByOther(boxPatient)}
                title={
                  heldByOther(boxPatient) ? `${boxPatient.claim.by} is working this patient` : ""
                }
                onClick={complete}
              >
                {form === "pharmacy"
                  ? "💊 Dispensed — Confirm Exit (stops clock)"
                  : "✓ Done — move to next step"}
              </button>
              <button
                className="flow-btn flow-btn-ghost"
                style={{ padding: "8px 14px" }}
                disabled={advance.isPending || heldByOther(boxPatient)}
                onClick={() => setSkipTarget(boxPatient)}
                title={
                  heldByOther(boxPatient)
                    ? `${boxPatient.claim.by} is working this patient`
                    : "Skip this step — patient still advances"
                }
              >
                ⏭ Skip
              </button>
              {heldByMe(boxPatient) && (
                <button
                  className="flow-btn flow-btn-ghost"
                  style={{ padding: "8px 14px" }}
                  disabled={releaseStep.isPending}
                  onClick={() => release(boxPatient)}
                  title="Hand this patient back to the queue without completing"
                >
                  ↩ Release
                </button>
              )}
              <span className="flow-muted">
                {heldByOther(boxPatient)
                  ? `${boxPatient.claim.by} has this patient — ask them to release before you take over.`
                  : "Patient auto-moves to their next station"}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flow-card flow-empty">
          {freeMove
            ? "No patient selected. Pick one from the queue below."
            : "No patient in progress. Call in the next from your queue."}
        </div>
      )}

      {/* Queue — free-move: pick anyone into the box; else call-in order */}
      <div className="q-sec">
        <div className="q-sec-head">
          <span className="flow-sec-title" style={{ margin: 0 }}>
            {freeMove ? "My queue — pick anyone" : "My queue — ready to call in"}
            <span className="q-count">{listItems.length}</span>
          </span>
        </div>
        {listItems.length === 0 ? (
          <div className="flow-card flow-empty">No one waiting at this station.</div>
        ) : (
          listItems.map((s) => (
            <div
              key={s.id}
              className={`qrow${s.visit_urgency === "breach" ? " qrow--breach" : s.visit_urgency === "atrisk" ? " qrow--atrisk" : ""}`}
            >
              <span className="qrow-tok">{s.token_number || "—"}</span>
              <div className="qrow-main">
                <div className="qrow-name">
                  {s.patient_name}
                  {s.is_vip && <span title="VIP">⭐</span>}
                </div>
                <div className="qrow-meta">
                  {s.patient_age_sex || ""} · {s.file_no} · {s.visit_type_id} · Step {s.step_order}{" "}
                  of {s.total_steps}
                </div>
                <div className="qrow-chips">
                  <span
                    className={`flow-badge ${s.visit_urgency === "breach" ? "fb-red" : s.visit_urgency === "atrisk" ? "fb-amb" : "fb-ink"}`}
                  >
                    {s.visit_remaining_min}m left of visit
                  </span>
                  <span className="flow-badge fb-ink">in since {fmtTime(s.checkin_time)}</span>
                  {s.status === "pending" && (
                    <span className="flow-badge fb-ink">upstream step still open</span>
                  )}
                  {s.claim && (
                    <span className={`flow-badge ${heldByMe(s) ? "fb-blu" : "fb-amb"}`}>
                      🔒 {heldByMe(s) ? "you have this patient" : `with ${s.claim.by}`}
                    </span>
                  )}
                </div>
              </div>
              <div className="qrow-actions">
                {freeMove ? (
                  <>
                    <button
                      className="flow-btn flow-btn-primary"
                      disabled={heldByOther(s) || claimStep.isPending}
                      title={
                        heldByOther(s)
                          ? `${s.claim.by} is working this patient`
                          : "Take this patient into the form box"
                      }
                      onClick={() => moveIntoBox(s)}
                    >
                      ↑ Move in
                    </button>
                    <button
                      className="flow-btn flow-btn-ghost"
                      disabled={advance.isPending || heldByOther(s)}
                      title={
                        heldByOther(s)
                          ? `${s.claim.by} is working this patient`
                          : "Skip — patient still advances"
                      }
                      onClick={() => setSkipTarget(s)}
                    >
                      ⏭ Skip
                    </button>
                  </>
                ) : (
                  <button
                    className="flow-btn flow-btn-primary"
                    disabled={!!active || startStep.isPending || heldByOther(s)}
                    title={
                      heldByOther(s)
                        ? `${s.claim.by} is working this patient`
                        : active
                          ? "Finish the current patient first"
                          : "Call in"
                    }
                    onClick={() => callIn(s.id)}
                  >
                    Call in
                  </button>
                )}
                {heldByMe(s) && (
                  <button
                    className="flow-btn flow-btn-ghost"
                    disabled={releaseStep.isPending}
                    title="Hand this patient back to the queue"
                    onClick={() => release(s)}
                  >
                    ↩ Release
                  </button>
                )}
                {canEditHere && (
                  <RemoveStepBtn
                    step={s}
                    busy={removeStep.isPending}
                    heldBy={heldByOther(s) ? s.claim.by : null}
                    onPick={setRemoveTarget}
                  />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="q-sec">
        <div className="q-sec-head">
          <span className="flow-sec-title" style={{ margin: 0 }}>
            {searching ? "Search results" : "Checked in today — not yet seen at this station"}
            <span className="q-count">{notSeenHere.length}</span>
          </span>
          <div className="q-search">
            <span aria-hidden="true">🔎</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, file no, phone or token…"
              aria-label="Search today's patients"
            />
            {search && (
              <button className="q-search-x" title="Clear search" onClick={() => setSearch("")}>
                ✕
              </button>
            )}
          </div>
        </div>
        {searching && (
          <div className="flow-muted" style={{ marginBottom: 6 }}>
            {searchBusy ? "Searching…" : `Matching today’s patients for “${debounced}”`}
          </div>
        )}

        {notSeenHere.length === 0 ? (
          <div className="flow-card flow-empty">
            {searching
              ? `No patient today matches “${debounced}”.`
              : "Everyone checked in has either been through this station or is in your queue above."}
          </div>
        ) : (
          notSeenHere.map(({ visit: v, step }) => {
            const settled = settledHere(v);
            const queuedHere = myVisitIds.has(v.id);
            return (
              <div key={v.id} className="qrow qrow--muted">
                <span className="qrow-tok">{v.token_number || "—"}</span>
                <div className="qrow-main">
                  <div className="qrow-name">
                    {v.patient_name}
                    {v.is_vip && <span title="VIP">⭐</span>}
                  </div>
                  <div className="qrow-meta">
                    {v.patient_id}
                    {v.patient_age_sex ? ` · ${v.patient_age_sex}` : ""} ·{" "}
                    {VISIT_STATUS_LABEL[v.status] || v.status}
                  </div>
                  <div className="qrow-chips">
                    <span className="flow-badge fb-ink">
                      {step ? `now at ${step.step_name}` : "journey not started"}
                    </span>
                    {queuedHere && <span className="flow-badge fb-blu">already in your queue</span>}
                    {settled && !queuedHere && (
                      <span className="flow-badge fb-grn">done at this station</span>
                    )}
                  </div>
                </div>
                <div className="qrow-actions">
                  {canEditHere && myCatalogSteps.length > 0 && !queuedHere && (
                    <SendToStation
                      visit={v}
                      steps={myCatalogSteps}
                      busy={addStep.isPending}
                      onSend={sendToMyStation}
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {skipTarget && (
        <StepReasonDialog
          title={`Skip “${skipTarget.step_name}”`}
          subtitle={`${skipTarget.patient_name} · ${skipTarget.file_no} — they’ll move to the next step. Pick or type a reason (optional).`}
          reason={skipReason}
          setReason={setSkipReason}
          confirmLabel="⏭ Skip step"
          confirmClass="flow-btn-grn"
          busy={advance.isPending}
          onCancel={() => setSkipTarget(null)}
          onConfirm={confirmSkip}
        />
      )}

      {removeTarget && (
        <StepReasonDialog
          title={`Remove “${removeTarget.step_name}”`}
          subtitle={`${removeTarget.patient_name} · ${removeTarget.file_no} — this step leaves their journey entirely. A step already started is kept and marked skipped instead.`}
          reason={removeReason}
          setReason={setRemoveReason}
          confirmLabel="✕ Remove step"
          confirmClass="flow-btn-red"
          busy={removeStep.isPending}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={confirmRemove}
        />
      )}
    </>
  );
}

function SendToStation({ visit, steps, busy, onSend }) {
  if (steps.length === 1) {
    return (
      <button
        className="flow-btn flow-btn-ghost"
        disabled={busy}
        title={`Add "${steps[0].name}" to this patient's journey and queue them here`}
        onClick={() => onSend(visit, steps[0].id)}
      >
        → Send to my station
      </button>
    );
  }
  return (
    <select
      className="jb-addsel"
      value=""
      disabled={busy}
      title="Add a step for this station to the patient's journey"
      onChange={(e) => {
        if (e.target.value) onSend(visit, e.target.value);
        e.target.value = "";
      }}
    >
      <option value="">→ Send to my station…</option>
      {steps.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function RemoveStepBtn({ step, busy, heldBy, onPick }) {
  return (
    <button
      className="flow-btn flow-btn-ghost"
      style={{ color: "var(--fre)", borderColor: "var(--fre)" }}
      disabled={busy || !!heldBy}
      title={
        heldBy
          ? `${heldBy} is working this patient — they must release it first`
          : "Remove this step from the patient's journey"
      }
      onClick={() => onPick(step)}
    >
      ✕ Remove
    </button>
  );
}

// Shared confirm-with-reason modal for skipping and for removing a step.
function StepReasonDialog({
  title,
  subtitle,
  reason,
  setReason,
  confirmLabel,
  confirmClass,
  busy,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flow-card"
        style={{ width: "100%", maxWidth: 380, borderRadius: 10 }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div className="flow-muted" style={{ marginBottom: 10 }}>
          {subtitle}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {SKIP_REASONS.map((r) => (
            <button
              key={r}
              className={`flow-btn ${reason === r ? "flow-btn-primary" : "flow-btn-ghost"}`}
              style={{ padding: "5px 10px", fontSize: 12 }}
              onClick={() => setReason(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onConfirm()}
          placeholder="Reason (optional)…"
          style={{ width: "100%", padding: "8px 10px", marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="flow-btn flow-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={`flow-btn ${confirmClass}`} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Role-specific data-entry forms. Values are stored in step.data on advance.
function StationForm({ form, value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  if (form === "vitals") {
    return <VitalsForm value={value} onChange={onChange} />;
  }
  if (form === "lab") {
    return (
      <Field label="Result notes">
        <textarea
          rows={3}
          value={value.result_notes || ""}
          onChange={(e) => set("result_notes", e.target.value)}
          placeholder="Sample taken / result ready / notes…"
        />
      </Field>
    );
  }
  if (form === "pharmacy") {
    return (
      <Field label="Dispense notes">
        <textarea
          rows={2}
          value={value.dispense_notes || ""}
          onChange={(e) => set("dispense_notes", e.target.value)}
          placeholder="Medicines dispensed / stock notes…"
        />
      </Field>
    );
  }
  if (form === "rx") {
    return (
      <Field label="Explanation notes">
        <textarea
          rows={2}
          value={value.notes || ""}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Medicines explained · patient understood…"
        />
      </Field>
    );
  }
  return (
    <Field label="Notes">
      <textarea
        rows={3}
        value={value.notes || ""}
        onChange={(e) => set("notes", e.target.value)}
        placeholder="Notes / observations…"
      />
    </Field>
  );
}

// Core vitals (always shown) + an "+ Add vital" picker for extra standard or
// custom vitals, recorded per patient. Everything is stored in step.data, so
// any added key persists. Remounts per patient (keyed on the active step).
const OPTIONAL_VITALS = [
  ["temperature", "Temp (°F)"],
  ["rbs", "RBS (mg/dL)"],
  ["height", "Height (cm)"],
  ["bmi", "BMI"],
  ["waist", "Waist (cm)"],
  ["body_fat", "Body fat (%)"],
  ["muscle_mass", "Muscle mass (kg)"],
  ["resp_rate", "Resp. rate (/min)"],
  ["pain_score", "Pain (0–10)"],
];
const CORE_VITAL_KEYS = ["weight", "bp_sys", "bp_dia", "pulse", "spo2"];
// Shown for every patient alongside the core vitals. Still removable per
// patient via the ✕, and re-addable from the "+ Add vital" picker.
const DEFAULT_EXTRA_VITALS = ["bmi", "body_fat"];

function VitalsForm({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const removeKey = (k) => {
    const nv = { ...value };
    delete nv[k];
    onChange(nv);
    setExtras((a) => a.filter((e) => e.key !== k));
  };
  // Extra (optional/custom) vitals the associate has added for this patient.
  const [extras, setExtras] = useState(() => {
    const keys = [
      ...DEFAULT_EXTRA_VITALS,
      ...Object.keys(value).filter((k) => !CORE_VITAL_KEYS.includes(k)),
    ];
    return [...new Set(keys)].map((k) => ({
      key: k,
      label: OPTIONAL_VITALS.find((o) => o[0] === k)?.[1] || k,
    }));
  });

  const addOptional = (key) => {
    const o = OPTIONAL_VITALS.find((x) => x[0] === key);
    if (!o || extras.some((e) => e.key === key)) return;
    setExtras((a) => [...a, { key, label: o[1] }]);
  };
  const addCustom = () => {
    const label = window.prompt("Name of vital (e.g. Grip strength, GRBS, Temp axilla):");
    if (!label || !label.trim()) return;
    const key =
      "x_" +
      label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    if (!key || extras.some((e) => e.key === key)) return;
    setExtras((a) => [...a, { key, label: label.trim() }]);
  };
  const remaining = OPTIONAL_VITALS.filter((o) => !extras.some((e) => e.key === o[0]));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <Field label="Weight (kg)">
          <input
            type="number"
            value={value.weight || ""}
            onChange={(e) => set("weight", e.target.value)}
          />
        </Field>
        <Field label="BP (mmHg)">
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Sys"
              value={value.bp_sys || ""}
              onChange={(e) => set("bp_sys", e.target.value)}
            />
            <span>/</span>
            <input
              type="number"
              placeholder="Dia"
              value={value.bp_dia || ""}
              onChange={(e) => set("bp_dia", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Pulse (bpm)">
          <input
            type="number"
            value={value.pulse || ""}
            onChange={(e) => set("pulse", e.target.value)}
          />
        </Field>
        <Field label="SpO2 (%)">
          <input
            type="number"
            value={value.spo2 || ""}
            onChange={(e) => set("spo2", e.target.value)}
          />
        </Field>
        {extras.map((ex) => (
          <Field
            key={ex.key}
            label={
              <span
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                {ex.label}
                <button
                  onClick={() => removeKey(ex.key)}
                  title="Remove"
                  style={{
                    border: "none",
                    background: "none",
                    color: "var(--fre)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              </span>
            }
          >
            <input value={value[ex.key] || ""} onChange={(e) => set(ex.key, e.target.value)} />
          </Field>
        ))}
      </div>
      <select
        className="jb-add"
        style={{ marginTop: 8, maxWidth: 260 }}
        value=""
        onChange={(e) => {
          if (e.target.value === "__custom") addCustom();
          else if (e.target.value) addOptional(e.target.value);
          e.target.value = "";
        }}
      >
        <option value="">+ Add vital…</option>
        {remaining.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
        <option value="__custom">Custom…</option>
      </select>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flow-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
