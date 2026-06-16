import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";
import VisitDetailModal from "../../components/flow/VisitDetailModal";
import {
  useFlowVisitTypes,
  useFlowTemplate,
  useFlowStepCatalog,
  useFlowStaff,
  useFlowVisits,
  useFlowCheckin,
  useFlowCancel,
} from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// The 4 patient-type buttons (prototype). Tests toggle splits FU+Appt into the
// reports-ready (FU_APPT, 45m) vs needs-samples (FU_APPT_TESTS, 90m) benchmark.
const TYPE_BUTTONS = [
  {
    key: "fu_appt",
    label: "📋 Follow-up + Appointment",
    meta: "≤ 45 min (reports ready) · ≤ 90 (needs tests)",
    followUp: true,
    walk: false,
  },
  {
    key: "new_appt",
    label: "📋 New + Appointment",
    meta: "≤ 90 min",
    followUp: false,
    walk: false,
    visitType: "NEW_APPT",
  },
  {
    key: "fu_walk",
    label: "🚶 Follow-up + Walk-in",
    meta: "≤ 90 min (flexible)",
    followUp: true,
    walk: true,
    visitType: "FU_WALK",
  },
  {
    key: "new_walk",
    label: "🚶 New + Walk-in",
    meta: "≤ 120 min (flexible)",
    followUp: false,
    walk: true,
    visitType: "NEW_WALK",
  },
];

const resolveVisitType = (typeKey, testsAvailable) => {
  if (typeKey === "fu_appt") return testsAvailable ? "FU_APPT" : "FU_APPT_TESTS";
  return TYPE_BUTTONS.find((t) => t.key === typeKey)?.visitType || "NEW_APPT";
};

// OPD/GHM-aligned stage labels — same vocabulary as the OPD pages.
const STAGE_LABEL = {
  checkedin: "Checked-in",
  in_visit: "In-visit",
  seen: "Seen",
  billing: "Billing",
  at_pharmacy: "At pharmacy",
  completed: "Done",
  cancelled: "Cancelled",
};

// The +91 country code is fixed in the UI; form.phone holds just the 10 local
// digits. A valid Indian mobile is 10 digits starting 6–9.
const isValidMobile = (local) => /^[6-9]\d{9}$/.test(local || "");
// What we store/send: 91 + the 10 local digits (no +), for WhatsApp.
const normalizeMobile = (local) => `91${local}`;
// When pulling an existing patient's saved phone (which may include code/format),
// keep just the last 10 digits to fit the +91-prefixed field.
const toLocal10 = (raw) => (raw || "").replace(/\D/g, "").slice(-10);

const ageSex = (p) => (p ? `${p.age ?? ""}${(p.sex || "").charAt(0).toUpperCase()}`.trim() : "");

// Parse the start time out of an appointment slot ("9:30 AM to 10 AM",
// "09:30", "9:30 AM") → "HH:MM" for the <input type="time"> prefill.
const parseSlotToHHMM = (slot) => {
  if (!slot) return "";
  const m = String(slot).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

// "09:30" (from <input type="time">) → "9:30 AM" for storage/display.
const fmt12 = (hhmm) => {
  if (!hhmm || !hhmm.includes(":")) return hhmm || "";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
};

let uidc = 0;
const uid = () => `s${++uidc}`;

export default function FlowCheckinPage() {
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const fetchDoctorsList = useAuthStore((s) => s.fetchDoctorsList);
  const actorName = useAuthStore((s) => s.currentDoctor?.short_name || s.currentDoctor?.name);

  const [typeKey, setTypeKey] = useState("fu_appt");
  const [testsAvailable, setTestsAvailable] = useState(true);
  const [isVip, setIsVip] = useState(false);
  const [fuStatus, setFuStatus] = useState("improving");
  const [form, setForm] = useState({
    name: "",
    file_no: "",
    phone: "",
    appt_time: "",
    notes: "",
    age: "",
    sex: "",
  });
  const [patientDbId, setPatientDbId] = useState(null);
  const [sd, setSd] = useState({ id: null, name: "" });
  const [chief, setChief] = useState({ id: null, name: "" });
  const [steps, setSteps] = useState([]);
  const [dragIdx, setDragIdx] = useState(null);
  const [search, setSearch] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [ageSexVal, setAgeSexVal] = useState(null); // "71M" — carried into the visit
  const [context, setContext] = useState(null); // { lastVisit, conName, moName, vitals, appt }
  const [appointmentId, setAppointmentId] = useState(null); // linked OPD/GHM appointment
  const [pendingMo, setPendingMo] = useState(null); // {id,name} to assign to the MO step on (re)load
  const [errors, setErrors] = useState([]);
  const [touched, setTouched] = useState({});
  const [attempted, setAttempted] = useState(false);
  const markTouched = (f) => setTouched((t) => ({ ...t, [f]: true }));

  const selected = TYPE_BUTTONS.find((t) => t.key === typeKey);
  const visitTypeId = resolveVisitType(typeKey, testsAvailable);

  const { data: visitTypes = [] } = useFlowVisitTypes();
  const { data: template = [] } = useFlowTemplate(visitTypeId);
  const { data: catalog = [] } = useFlowStepCatalog();
  const { data: staff = [] } = useFlowStaff();
  const { data: todays = [] } = useFlowVisits();
  const checkin = useFlowCheckin();
  const cancelVisit = useFlowCancel();
  const [cancelTarget, setCancelTarget] = useState(null); // visit pending cancel-confirm
  const [detailId, setDetailId] = useState(null); // visit whose detail/edit modal is open

  const confirmCancel = async () => {
    const v = cancelTarget;
    if (!v) return;
    try {
      await cancelVisit.mutateAsync({ visitId: v.id, reason: "reception_cancel" });
      toast(`Check-in cancelled for ${v.patient_name}`, "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setCancelTarget(null);
    }
  };

  const maxTime = visitTypes.find((t) => t.id === visitTypeId)?.max_time_min || 0;

  useEffect(() => {
    if (!doctorsList?.length) fetchDoctorsList();
  }, [doctorsList, fetchDoctorsList]);

  // Patient search
  const { data: results = [] } = useQuery({
    queryKey: ["flow", "patient-search", search],
    queryFn: async () => {
      const { data } = await api.get(`/api/patients?q=${encodeURIComponent(search)}&limit=6`);
      // GET /api/patients returns { data: [...rows], page, total, ... }
      return Array.isArray(data) ? data : data?.data || data?.patients || [];
    },
    enabled: search.trim().length >= 2,
    staleTime: 10_000,
  });

  // Build staff/doctor options for a step's role.
  const optionsForRole = useMemo(() => {
    const docs = (doctorsList || [])
      .filter((d) => d.is_active !== false)
      .map((d) => ({ id: String(d.id), name: d.short_name || d.name }));
    return (role) => {
      if (["sd", "chief", "mo"].includes(role)) return docs;
      return staff.filter((s) => s.role === role).map((s) => ({ id: String(s.id), name: s.name }));
    };
  }, [doctorsList, staff]);

  // The doctor to pre-assign to a given consult step, from the patient's care
  // team. Defaults exist in the catalog; the *assignee* is dynamic per patient.
  const staffForStep = (catId) => {
    if (catId === "mo_assessment" && pendingMo)
      return { id: String(pendingMo.id), name: pendingMo.name };
    if (catId === "sd_consult" && sd.id) return { id: String(sd.id), name: sd.name };
    if (catId === "chief_consult" && chief.id) return { id: String(chief.id), name: chief.name };
    return { id: null, name: null };
  };

  // Load template into the editable journey whenever the visit type changes,
  // pre-assigning consult steps (MO/SD/Chief) from the patient's care team.
  // (sd/chief are read here but kept out of deps — live changes are handled by
  // the sync effect below so editing durations isn't wiped.)
  useEffect(() => {
    if (!template.length) return;
    setSteps(
      template.map((t) => {
        const who = staffForStep(t.step_catalog_id);
        return {
          uid: uid(),
          step_catalog_id: t.step_catalog_id,
          step_name: t.step_name,
          planned_duration_min: t.planned_duration_min,
          station: t.station,
          assigned_role: t.assigned_role,
          assigned_staff_id: who.id,
          assigned_staff_name: who.name,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, pendingMo]);

  // Keep the SD/Chief consult steps in sync when their top-level assignment
  // changes (manual pick or auto-fill) — updates only those steps' assignee,
  // never the durations/order.
  useEffect(() => {
    setSteps((arr) =>
      arr.map((s) => {
        if (s.step_catalog_id === "sd_consult" && sd.id)
          return { ...s, assigned_staff_id: String(sd.id), assigned_staff_name: sd.name };
        if (s.step_catalog_id === "chief_consult" && chief.id)
          return { ...s, assigned_staff_id: String(chief.id), assigned_staff_name: chief.name };
        return s;
      }),
    );
  }, [sd, chief]);

  const total = steps.reduce((a, s) => a + (parseInt(s.planned_duration_min) || 0), 0);
  const buffer = maxTime - total;

  // Match a free-text doctor name (con_name / mo_name) to a row in doctorsList.
  const matchDoctor = (nm) => {
    if (!nm) return null;
    const low = nm.toLowerCase();
    return (doctorsList || []).find((d) => {
      const sn = (d.short_name || "").toLowerCase();
      const fn = (d.name || "").toLowerCase();
      return (
        (sn && (low.includes(sn) || sn.includes(low))) ||
        (fn && (low.includes(fn) || fn.includes(low)))
      );
    });
  };

  const pickPatient = async (p) => {
    setForm((f) => ({
      ...f,
      name: p.name || "",
      file_no: p.file_no || "",
      phone: toLocal10(p.phone),
      age: p.age ?? "",
      sex: p.sex || "",
    }));
    setPatientDbId(p.id || null);
    setAgeSexVal(ageSex(p) || null);
    setSearch("");
    setShowResults(false);
    setContext(null);
    setAppointmentId(null);
    setPendingMo(null);
    // Best-effort: pull the patient record (care team + last vitals) and today's
    // appointment (time / type / doctor) in parallel to pre-fill the form.
    try {
      const [detailRes, apptRes] = await Promise.all([
        api.get(`/api/patients/${p.id}`),
        api
          .get(
            `/api/flow/patient-appointment?patient_db_id=${p.id}&file_no=${encodeURIComponent(p.file_no || "")}`,
          )
          .catch(() => ({ data: null })),
      ]);
      const data = detailRes.data;
      const appt = apptRes.data;

      if (!ageSex(p) && (data.age || data.sex)) setAgeSexVal(ageSex(data) || null);
      const lastConsult = (data.consultations || []).find((c) => c.con_name || c.mo_name);
      const vitals = (data.vitals || [])[0] || null;

      // Today's appointment → visit type, time, linked id.
      if (appt) {
        setAppointmentId(appt.id);
        const isFollowUp = /follow|f\/?u|review/i.test(appt.visit_type || "");
        setTypeKey(isFollowUp ? "fu_appt" : "new_appt"); // has an appointment → appointment type
        const hhmm = parseSlotToHHMM(appt.time_slot);
        if (hhmm) setForm((f) => ({ ...f, appt_time: hhmm }));
      }

      setContext({
        lastVisit: lastConsult?.visit_date || null,
        conName: lastConsult?.con_name || null,
        moName: lastConsult?.mo_name || null,
        vitals,
        appt: appt
          ? {
              time_slot: appt.time_slot,
              visit_type: appt.visit_type,
              doctor_name: appt.doctor_name,
              status: appt.status,
            }
          : null,
      });

      // Pre-fill SD: prefer today's appointment doctor, else usual consultant.
      const sdDoc = matchDoctor(appt?.doctor_name) || matchDoctor(lastConsult?.con_name);
      if (sdDoc) setSd({ id: String(sdDoc.id), name: sdDoc.short_name || sdDoc.name });
      // Queue the usual MO for the MO step (applied by the template effect so it
      // survives the visit-type switch above).
      const moDoc = matchDoctor(lastConsult?.mo_name);
      if (moDoc) setPendingMo({ id: moDoc.id, name: moDoc.short_name || moDoc.name });

      // Derive the chief dynamically from the configurable is_chief flag:
      // prefer a chief the patient has actually seen before, else the sole chief.
      const chiefs = (doctorsList || []).filter((d) => d.is_chief);
      const conNames = (data.consultations || []).map((c) => (c.con_name || "").toLowerCase());
      let chiefDoc = chiefs.find((d) => {
        const sn = (d.short_name || "").toLowerCase();
        const fn = (d.name || "").toLowerCase();
        return conNames.some((nm) => nm && ((sn && nm.includes(sn)) || (fn && nm.includes(fn))));
      });
      if (!chiefDoc && chiefs.length === 1) chiefDoc = chiefs[0]; // sensible default when only one
      if (chiefDoc)
        setChief({ id: String(chiefDoc.id), name: chiefDoc.short_name || chiefDoc.name });
    } catch {
      /* context is best-effort — check-in still works without it */
    }
  };

  const updateStep = (u, patch) =>
    setSteps((arr) => arr.map((s) => (s.uid === u ? { ...s, ...patch } : s)));
  const removeStep = (u) => setSteps((arr) => arr.filter((s) => s.uid !== u));
  // Reorder by index (used by both native drag and the up/down buttons).
  const moveStep = (from, to) =>
    setSteps((arr) => {
      if (to < 0 || to >= arr.length || from === to) return arr;
      const next = arr.slice();
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
  const addStep = (catId) => {
    const c = catalog.find((x) => x.id === catId);
    if (!c) return;
    setSteps((arr) => [
      ...arr,
      {
        uid: uid(),
        step_catalog_id: c.id,
        step_name: c.name,
        planned_duration_min: c.default_duration_min,
        station: c.station,
        assigned_role: c.assigned_role,
        assigned_staff_id: null,
        assigned_staff_name: null,
      },
    ]);
  };

  const doneBy = useMemo(() => {
    const d = new Date(Date.now() + total * 60000);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }, [total]);

  // Per-type validation. Appointment visits need an appointment time;
  // follow-ups need a status; WhatsApp needs a phone; every step needs a budget.
  const validate = (sendWhatsapp) => {
    const errs = [];
    const hasPhone = !!form.phone.trim();
    if (!form.name.trim()) errs.push("Patient name is required");
    // File number is NOT required — for new patients it's auto-generated (GNI-#####)
    // by the patient record created at check-in.
    if (!selected?.walk && !form.appt_time.trim())
      errs.push("Appointment time is required for appointment visits");
    if (selected?.followUp && !fuStatus)
      errs.push("Select follow-up status (Improving / Same / Worse)");
    if (hasPhone && !isValidMobile(form.phone))
      errs.push("Enter a valid 10-digit mobile number (starts with 6–9)");
    if (sendWhatsapp && !hasPhone) errs.push("Mobile number is required to send WhatsApp");
    if (!steps.length) errs.push("Add at least one journey step");
    else if (steps.some((s) => !(parseInt(s.planned_duration_min) > 0)))
      errs.push("Every journey step needs a duration greater than 0 min");
    return errs;
  };

  // Per-field messages for inline (live) UI validation.
  const fieldErrors = {
    name: !form.name.trim() ? "Patient name is required" : "",
    appt_time: !selected?.walk && !form.appt_time.trim() ? "Required for appointment visits" : "",
    phone:
      form.phone.trim() && !isValidMobile(form.phone) ? "Enter a 10-digit mobile starting 6–9" : "",
  };
  // Show a field's error once it's been touched (blurred) or a submit was tried.
  const showErr = (f) => (touched[f] || attempted) && fieldErrors[f];
  const errStyle = (f) => (showErr(f) ? { borderColor: "var(--fre)" } : undefined);

  const submit = async (sendWhatsapp) => {
    setAttempted(true);
    const errs = validate(sendWhatsapp);
    if (errs.length) {
      setErrors(errs);
      toast(errs[0], "warn");
      return;
    }
    setErrors([]);
    try {
      // Resolve the patient. If one wasn't picked from search, create/upsert a
      // record — this mints a GNI-##### file number for new patients (reusing the
      // app's existing generator) so reception never has to invent one.
      let fileNo = form.file_no.trim();
      let dbId = patientDbId;
      if (!dbId) {
        const { data: pt } = await api.post("/api/patients", {
          name: form.name.trim(),
          phone: form.phone || null,
          file_no: fileNo || undefined,
          age: form.age ? parseInt(form.age) : undefined,
          sex: form.sex || undefined,
        });
        dbId = pt.id;
        fileNo = pt.file_no;
      }

      // Prefer the form's age/sex (covers new patients); fall back to the
      // looked-up value for existing patients.
      const ageSexFromForm =
        form.age || form.sex
          ? `${form.age || ""}${(form.sex || "").charAt(0).toUpperCase()}`.trim()
          : null;
      const payload = {
        patient_id: fileNo,
        patient_db_id: dbId,
        appointment_id: appointmentId,
        patient_name: form.name.trim(),
        patient_phone: form.phone.trim() ? normalizeMobile(form.phone) : null,
        patient_age_sex: ageSexFromForm || ageSexVal || null,
        visit_type_id: visitTypeId,
        appointment_time: form.appt_time ? fmt12(form.appt_time) : null,
        has_tests_available: !!testsAvailable,
        patient_status: selected?.followUp ? fuStatus : "new_patient",
        is_vip: isVip,
        notes: form.notes.trim() || null,
        assigned_sd: sd.id,
        assigned_sd_name: sd.name || null,
        assigned_chief: chief.id,
        assigned_chief_name: chief.name || null,
        journey_steps: steps.map((s) => ({
          step_catalog_id: s.step_catalog_id,
          step_name: s.step_name,
          planned_duration_min: parseInt(s.planned_duration_min) || 0,
          station: s.station,
          assigned_role: s.assigned_role,
          assigned_staff_id: s.assigned_staff_id,
          assigned_staff_name: s.assigned_staff_name,
        })),
        send_whatsapp: sendWhatsapp,
      };
      const res = await checkin.mutateAsync(payload);
      toast(`Checked in ${form.name} · File ${fileNo}`, "success");
      // reset patient-specific fields + touched state, keep type selection
      setForm({ name: "", file_no: "", phone: "", appt_time: "", notes: "", age: "", sex: "" });
      setPatientDbId(null);
      setIsVip(false);
      setTouched({});
      setAttempted(false);
      setAgeSexVal(null);
      setContext(null);
      setAppointmentId(null);
      setPendingMo(null);
      setSd({ id: null, name: "" });
      setChief({ id: null, name: "" });
    } catch (e) {
      toast(e?.response?.data?.error || e.message, "error");
    }
  };

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div className="flow-header">
          <div>
            <div className="flow-title">🏥 Reception — Patient Check-In</div>
            <div className="flow-sub">
              Register · build journey · assign care team · {new Date().toLocaleDateString()}
            </div>
          </div>
          <div className="flow-header-right">
            <div className="flow-stat" style={{ padding: "6px 12px", minWidth: 0 }}>
              <div className="flow-stat-val f-grn" style={{ fontSize: 20 }}>
                {todays.length}
              </div>
              <div className="flow-stat-lbl">Checked in today</div>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {/* LEFT — form */}
          <div className="flow-card">
            <div className="flow-sec-title">Check-in patient</div>

            <label className="flow-stat-lbl" style={{ display: "block", marginBottom: 6 }}>
              Patient type & visit
            </label>
            <div className="flow-type-grid" style={{ marginBottom: 12 }}>
              {TYPE_BUTTONS.map((t) => (
                <div
                  key={t.key}
                  className={`flow-type-btn${typeKey === t.key ? " selected" : ""}`}
                  onClick={() => setTypeKey(t.key)}
                >
                  <div className="flow-type-label">{t.label}</div>
                  <div className="flow-type-meta">{t.meta}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <div
                className={`flow-toggle${testsAvailable ? " on" : ""}`}
                onClick={() => setTestsAvailable((v) => !v)}
              >
                {testsAvailable ? "🔬 Tests available" : "❌ No tests (needs samples)"}
              </div>
              <div
                className={`flow-toggle${isVip ? " on-vip" : ""}`}
                onClick={() => setIsVip((v) => !v)}
              >
                ⭐ VIP patient
              </div>
            </div>

            {selected?.followUp && (
              <div style={{ marginBottom: 12 }}>
                <label className="flow-stat-lbl" style={{ display: "block", marginBottom: 6 }}>
                  Follow-up status
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    ["improving", "✅ Improving"],
                    ["same", "➡️ Same"],
                    ["worse", "⬇️ Worse"],
                  ].map(([v, l]) => (
                    <div
                      key={v}
                      className={`flow-toggle${fuStatus === v ? " on" : ""}`}
                      style={{ textAlign: "center" }}
                      onClick={() => setFuStatus(v)}
                    >
                      {l}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Patient lookup */}
            <div className="flow-field" style={{ marginBottom: 10, position: "relative" }}>
              <label>Find patient (name / file / phone)</label>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShowResults(true);
                }}
                placeholder="Search existing patient…"
              />
              {showResults && results.length > 0 && (
                <div
                  className="flow-card"
                  style={{
                    position: "absolute",
                    zIndex: 20,
                    top: "100%",
                    left: 0,
                    right: 0,
                    padding: 4,
                    maxHeight: 220,
                    overflow: "auto",
                  }}
                >
                  {results.map((p) => (
                    <div
                      key={p.id}
                      style={{ padding: "6px 8px", cursor: "pointer", fontSize: 12 }}
                      onClick={() => pickPatient(p)}
                    >
                      <b>{p.name}</b>{" "}
                      <span className="flow-muted">
                        {p.file_no} · {ageSex(p)} · {p.phone}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flow-grid2" style={{ marginBottom: 10 }}>
              <div className="flow-field">
                <label>Patient name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  onBlur={() => markTouched("name")}
                  style={errStyle("name")}
                />
                {showErr("name") && <FieldErr>{fieldErrors.name}</FieldErr>}
              </div>
              <div className="flow-field">
                <label>
                  File number{" "}
                  <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                    (auto for new patients)
                  </span>
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    style={{ flex: 1 }}
                    value={form.file_no}
                    onChange={(e) => setForm({ ...form, file_no: e.target.value })}
                    placeholder={patientDbId ? "" : "Auto-generated (GNI-…)"}
                    readOnly={!!patientDbId}
                  />
                  <button
                    className="flow-btn flow-btn-ghost"
                    title="Clear the form to register a brand-new patient"
                    onClick={() => {
                      setForm({
                        name: "",
                        file_no: "",
                        phone: "",
                        appt_time: "",
                        notes: "",
                        age: "",
                        sex: "",
                      });
                      setPatientDbId(null);
                      setTouched({});
                      setAgeSexVal(null);
                      setContext(null);
                      setAppointmentId(null);
                      setPendingMo(null);
                      setSd({ id: null, name: "" });
                      setChief({ id: null, name: "" });
                    }}
                  >
                    New patient
                  </button>
                </div>
              </div>
              <div className="flow-field">
                <label>Phone (WhatsApp)</label>
                <div style={{ display: "flex" }}>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "0 8px",
                      border: "1px solid var(--fbd)",
                      borderRight: "none",
                      borderRadius: "6px 0 0 6px",
                      background: "var(--fbg)",
                      color: "var(--fink3)",
                      fontWeight: 600,
                    }}
                  >
                    +91
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="10-digit mobile"
                    value={form.phone}
                    // Digits only, max 10 — strip anything else as typed/pasted.
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
                    }
                    onKeyDown={(e) => {
                      if (e.key.length === 1 && !/[0-9]/.test(e.key) && !e.ctrlKey && !e.metaKey)
                        e.preventDefault();
                    }}
                    onBlur={() => markTouched("phone")}
                    style={{
                      flex: 1,
                      borderRadius: "0 6px 6px 0",
                      ...(form.phone.trim() && !isValidMobile(form.phone)
                        ? { borderColor: "var(--fre)" }
                        : {}),
                    }}
                  />
                </div>
                {showErr("phone") && <FieldErr>{fieldErrors.phone}</FieldErr>}
              </div>
              <div className="flow-field">
                <label>Appointment time {selected?.walk ? "" : "*"}</label>
                <input
                  type="time"
                  value={form.appt_time}
                  onChange={(e) => setForm({ ...form, appt_time: e.target.value })}
                  onBlur={() => markTouched("appt_time")}
                  disabled={selected?.walk}
                  style={errStyle("appt_time")}
                />
                {showErr("appt_time") && <FieldErr>{fieldErrors.appt_time}</FieldErr>}
              </div>
            </div>

            {/* Age / sex — captured for new patients (registers them properly). */}
            <div className="flow-grid2" style={{ marginBottom: 10 }}>
              <div className="flow-field">
                <label>Age</label>
                <input
                  type="number"
                  min="0"
                  max="120"
                  inputMode="numeric"
                  placeholder="Years"
                  value={form.age}
                  onChange={(e) =>
                    setForm({ ...form, age: e.target.value.replace(/\D/g, "").slice(0, 3) })
                  }
                />
              </div>
              <div className="flow-field">
                <label>Sex</label>
                <select
                  value={form.sex}
                  onChange={(e) => setForm({ ...form, sex: e.target.value })}
                >
                  <option value="">—</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            {/* Auto-filled context for an existing patient (care team + last vitals) */}
            {context?.appt && (
              <div
                className="flow-alert flow-alert-grn"
                style={{ marginBottom: 10, padding: "8px 12px" }}
              >
                <span>📅</span>
                <div>
                  <b>Today's appointment</b>
                  {context.appt.time_slot ? ` · ${context.appt.time_slot}` : ""}
                  {context.appt.visit_type ? ` · ${context.appt.visit_type}` : ""}
                  {context.appt.doctor_name ? ` · ${context.appt.doctor_name}` : ""}
                  {context.appt.status ? ` · ${context.appt.status}` : ""}
                  <div style={{ fontSize: 10, opacity: 0.8 }}>
                    Pre-filled visit type, time & doctor · linked to this OPD appointment
                  </div>
                </div>
              </div>
            )}

            {context && (context.conName || context.moName || context.vitals) && (
              <div
                className="flow-card"
                style={{
                  marginBottom: 10,
                  padding: 10,
                  background: "var(--ftll)",
                  borderColor: "var(--ftl)",
                }}
              >
                <div
                  style={{ fontSize: 11, fontWeight: 700, color: "var(--ftl)", marginBottom: 4 }}
                >
                  📋 From last visit
                  {context.lastVisit
                    ? ` · ${new Date(context.lastVisit).toLocaleDateString()}`
                    : ""}
                  {ageSexVal ? ` · ${ageSexVal}` : ""}
                </div>
                <div style={{ fontSize: 11, color: "var(--fink2)" }}>
                  {context.conName && (
                    <span>
                      Doctor: <b>{context.conName}</b>
                      {matchDoctor(context.conName) ? " (pre-filled →)" : " (not in list)"}
                      {"   "}
                    </span>
                  )}
                  {context.moName && (
                    <span>
                      · MO: <b>{context.moName}</b>
                    </span>
                  )}
                </div>
                {context.vitals && (
                  <div style={{ fontSize: 11, color: "var(--fink2)", marginTop: 3 }}>
                    Last vitals:{" "}
                    {[
                      context.vitals.weight && `Wt ${context.vitals.weight}kg`,
                      (context.vitals.bp_sys || context.vitals.bp_dia) &&
                        `BP ${context.vitals.bp_sys ?? "–"}/${context.vitals.bp_dia ?? "–"}`,
                      context.vitals.pulse && `Pulse ${context.vitals.pulse}`,
                      context.vitals.spo2 && `SpO2 ${context.vitals.spo2}%`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "none on record"}
                  </div>
                )}
              </div>
            )}

            <div className="flow-grid2" style={{ marginBottom: 10 }}>
              <div className="flow-field">
                <label>Assign SD</label>
                <select
                  value={sd.id || ""}
                  onChange={(e) =>
                    setSd({
                      id: e.target.value || null,
                      name: e.target.selectedOptions[0]?.dataset.name || "",
                    })
                  }
                >
                  <option value="">—</option>
                  {(doctorsList || [])
                    .filter((d) => d.is_active !== false)
                    .map((d) => (
                      <option key={d.id} value={d.id} data-name={d.short_name || d.name}>
                        {d.short_name || d.name}
                      </option>
                    ))}
                </select>
                <DoctorAvailability doctorId={sd.id} apptTime={form.appt_time} />
              </div>
              <div className="flow-field">
                <label>Assign Chief</label>
                <select
                  value={chief.id || ""}
                  onChange={(e) =>
                    setChief({
                      id: e.target.value || null,
                      name: e.target.selectedOptions[0]?.dataset.name || "",
                    })
                  }
                >
                  <option value="">Auto / none</option>
                  {(doctorsList || [])
                    .filter((d) => d.is_active !== false)
                    .map((d) => (
                      <option key={d.id} value={d.id} data-name={d.short_name || d.name}>
                        {d.short_name || d.name}
                      </option>
                    ))}
                </select>
                <DoctorAvailability doctorId={chief.id} apptTime={form.appt_time} />
              </div>
            </div>

            <div className="flow-field">
              <label>Notes</label>
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="e.g. CKD Stage 4 · refer to Chief"
              />
            </div>
          </div>

          {/* RIGHT — journey builder */}
          <div className="flow-card">
            <div className="flow-sec-title">
              Patient journey{" "}
              <span className="flow-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                edit durations · assign · add steps
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto 64px 150px 22px",
                gap: 6,
                alignItems: "center",
                fontSize: 9,
                fontWeight: 700,
                color: "var(--fink3)",
                textTransform: "uppercase",
                letterSpacing: ".08em",
                padding: "0 4px 6px",
              }}
            >
              <span>Step</span>
              <span />
              <span style={{ textAlign: "center" }}>Min</span>
              <span style={{ textAlign: "center" }}>Assigned</span>
              <span />
            </div>

            {steps.map((s, i) => {
              const opts = optionsForRole(s.assigned_role);
              return (
                <div
                  key={s.uid}
                  className="jb-step"
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx !== null) moveStep(dragIdx, i);
                    setDragIdx(null);
                  }}
                  style={dragIdx === i ? { opacity: 0.5 } : undefined}
                >
                  <span
                    title="Drag to reorder"
                    style={{ cursor: "grab", color: "var(--fbd2)", fontSize: 14 }}
                  >
                    ⠿
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
                    <button
                      className="jb-remove"
                      style={{ color: "var(--fink3)", fontSize: 10 }}
                      disabled={i === 0}
                      onClick={() => moveStep(i, i - 1)}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      className="jb-remove"
                      style={{ color: "var(--fink3)", fontSize: 10 }}
                      disabled={i === steps.length - 1}
                      onClick={() => moveStep(i, i + 1)}
                      title="Move down"
                    >
                      ▼
                    </button>
                  </span>
                  <span className="jb-name">
                    {i + 1}. {s.step_name}
                  </span>
                  <input
                    className="jb-dur"
                    type="number"
                    min="0"
                    value={s.planned_duration_min}
                    onChange={(e) => updateStep(s.uid, { planned_duration_min: e.target.value })}
                  />
                  <select
                    className="jb-assign"
                    value={s.assigned_staff_id || ""}
                    onChange={(e) =>
                      updateStep(s.uid, {
                        assigned_staff_id: e.target.value || null,
                        assigned_staff_name: e.target.selectedOptions[0]?.dataset.name || null,
                      })
                    }
                  >
                    <option value="">{s.assigned_role}</option>
                    {opts.map((o) => (
                      <option key={o.id} value={o.id} data-name={o.name}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <button className="jb-remove" onClick={() => removeStep(s.uid)}>
                    ✕
                  </button>
                </div>
              );
            })}

            <select
              className="jb-add"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  addStep(e.target.value);
                  e.target.value = "";
                }
              }}
            >
              <option value="">+ Add step (ECG · Echo · TMT · VPT · X-Ray · Dietitian · …)</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.default_duration_min}m)
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                background: "var(--ftll)",
                borderRadius: 7,
                border: "1px solid var(--ftl)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ftl)" }}>
                  {steps.length} steps · Est. {total} min · Target ≤ {maxTime} min
                </div>
                <div style={{ fontSize: 10, color: buffer < 0 ? "var(--fre)" : "var(--ftl)" }}>
                  {buffer < 0 ? `Over target by ${-buffer} min` : `Buffer: ${buffer} min`} ·
                  Suggested wait ~{total} min
                </div>
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: buffer < 0 ? "var(--fre)" : "var(--ftl)",
                }}
              >
                {total}m
              </div>
            </div>

            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                background: "#e7f5e4",
                borderRadius: 7,
                border: "1px solid #c5e8c0",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: "#1a3a1a", marginBottom: 4 }}>
                📱 WhatsApp preview
              </div>
              <div style={{ fontSize: 11, color: "#1a3a1a", lineHeight: 1.5 }}>
                🏥 Gini Advanced Care
                <br />
                Namaste {form.name ? form.name.split(" ")[0] : "—"} ji! File: {form.file_no || "—"}
                <br />
                Doctor: {sd.name || "—"}
                {chief.name ? ` → ${chief.name}` : ""}
                <br />
                Est. visit: ~{total} min · Done by ~{doneBy}
              </div>
            </div>

            {errors.length > 0 && (
              <div
                className="flow-alert flow-alert-red"
                style={{ marginTop: 12, flexDirection: "column", gap: 2 }}
              >
                {errors.map((e, i) => (
                  <div key={i}>• {e}</div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                className="flow-btn flow-btn-primary"
                style={{ flex: 1, padding: 10 }}
                disabled={checkin.isPending}
                onClick={() => submit(true)}
              >
                ✓ Check In + Send WhatsApp
              </button>
              <button
                className="flow-btn flow-btn-ghost"
                style={{ padding: 10 }}
                disabled={checkin.isPending}
                onClick={() => submit(false)}
              >
                Check In Only
              </button>
            </div>
          </div>
        </div>

        {/* Today's check-ins */}
        <div style={{ marginTop: 16 }}>
          <div className="flow-sec-title">Checked in today — {todays.length}</div>
          {todays.length === 0 ? (
            <div className="flow-card flow-empty">No check-ins yet today.</div>
          ) : (
            <table className="flow-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Type</th>
                  <th>Steps</th>
                  <th>Check-in</th>
                  <th>Elapsed</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {todays.map((v) => (
                  <tr
                    key={v.id}
                    onClick={() => setDetailId(v.id)}
                    style={{ cursor: "pointer" }}
                    title="Click to edit journey / step times"
                  >
                    <td>
                      <b>{v.patient_name}</b>
                      {v.is_vip ? " ⭐" : ""}
                      <div className="flow-muted">
                        {v.patient_id} · {v.patient_age_sex || ""}
                      </div>
                    </td>
                    <td>
                      <span className="flow-badge fb-tl">{v.visit_type_id}</span>
                    </td>
                    <td>{v.steps?.length || 0}</td>
                    <td>
                      {new Date(v.checkin_time).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>{v._timing?.elapsed_min}m</td>
                    <td>
                      <span
                        className={`flow-badge ${v.status === "completed" ? "fb-grn" : v.status === "cancelled" ? "fb-ink" : v._timing?.urgency === "breach" ? "fb-red" : v._timing?.urgency === "atrisk" ? "fb-amb" : "fb-blu"}`}
                      >
                        {STAGE_LABEL[v.stage] || "Active"}
                        {v.status === "in_progress" && v._timing?.urgency === "breach"
                          ? " ⚠"
                          : v.status === "in_progress" && v._timing?.urgency === "atrisk"
                            ? " ⏱"
                            : ""}
                      </span>
                    </td>
                    <td>
                      {v.status === "in_progress" && (
                        <button
                          className="flow-btn flow-btn-ghost"
                          style={{
                            padding: "3px 8px",
                            color: "var(--fre)",
                            borderColor: "var(--fre)",
                          }}
                          disabled={cancelVisit.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCancelTarget(v);
                          }}
                          title="Cancel this check-in (started by mistake / patient not present)"
                        >
                          ✕ Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detailId && todays.find((v) => v.id === detailId) && (
        <VisitDetailModal
          visit={todays.find((v) => v.id === detailId)}
          onClose={() => setDetailId(null)}
        />
      )}

      <ConfirmModal
        open={!!cancelTarget}
        title="Cancel check-in?"
        message={
          cancelTarget
            ? `Remove ${cancelTarget.patient_name} from the patient flow. Use this for a mistaken check-in or a patient who isn't present. This cannot be undone.`
            : ""
        }
        confirmLabel="Cancel check-in"
        cancelLabel="Keep"
        onConfirm={confirmCancel}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}

// Inline field-level validation message.
function FieldErr({ children }) {
  return (
    <div style={{ color: "var(--fre)", fontSize: 10, fontWeight: 600, marginTop: 3 }}>
      {children}
    </div>
  );
}

// Human-readable reason a slot is blocked.
const SLOT_REASON = {
  day_off: "off today",
  clinic_holiday: "clinic holiday",
  not_working: "outside working hours",
  break: "on a break",
  leave: "on leave",
  holiday: "on holiday",
  emergency: "on emergency leave",
  manual_block: "slot blocked",
  full: "slot full",
};
const availOk = { color: "var(--fgn)", fontSize: 10, fontWeight: 600, marginTop: 3 };
const availWarn = { color: "var(--fre)", fontSize: 10, fontWeight: 700, marginTop: 3 };

// Availability for the assigned doctor (reads the existing doctor-availability
// system). With an appointment time, checks THAT specific slot; otherwise falls
// back to whether they're available at all today. Renders nothing until loaded.
function DoctorAvailability({ doctorId, apptTime }) {
  const today = new Date().toISOString().split("T")[0];
  const { data } = useQuery({
    queryKey: ["flow", "doc-avail", doctorId, today],
    queryFn: async () =>
      (await api.get(`/api/doctors/${doctorId}/availability?date=${today}`)).data,
    enabled: !!doctorId,
    staleTime: 60_000,
  });
  if (!doctorId || !data) return null;
  const slots = data.slots || [];
  if (!slots.length) return null;

  // Slot-specific: find the slot whose [start, end) contains the appointment time.
  const hhmm = apptTime && apptTime.length >= 5 ? apptTime.slice(0, 5) : null;
  const slot = hhmm
    ? slots.find(
        (s) => (s.start_time || "").slice(0, 5) <= hhmm && hhmm < (s.end_time || "").slice(0, 5),
      )
    : null;

  if (slot) {
    return slot.available ? (
      <div style={availOk}>✓ Free at {slot.slot_label}</div>
    ) : (
      <div style={availWarn}>
        ⚠ {SLOT_REASON[slot.blocked_by] || "unavailable"} at {slot.slot_label} — consider
        reassigning
      </div>
    );
  }

  // Fallback (walk-in / time outside catalog): is the doctor free at all today?
  const free = slots.filter((s) => s.available).length;
  return free === 0 ? (
    <div style={availWarn}>⚠ Off / on leave today — consider reassigning</div>
  ) : (
    <div style={availOk}>
      ✓ Available today ({free} slot{free === 1 ? "" : "s"})
    </div>
  );
}
