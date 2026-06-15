import { useEffect, useMemo, useState, useCallback } from "react";
import api from "../services/api";
import { toast } from "../stores/uiStore";
import FlowPanel from "../components/flow/FlowPanel";
import "./MedicineCollectionPage.css";

const todayISO = () => new Date().toISOString().split("T")[0];

const STATUS = [
  { v: "given", label: "Given" },
  { v: "not_given", label: "Not given" },
  { v: "partial", label: "Partial" },
];
const REASONS = [
  { v: "out_of_stock", label: "Out of stock" },
  { v: "patient_declined", label: "Patient declined" },
  { v: "buying_outside", label: "Buying outside" },
  { v: "not_available", label: "Not available" },
  { v: "other", label: "Other" },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.v, r.label]));
const ROLLUP = {
  all: { label: "All collected", cls: "ok" },
  partial: { label: "Partial", cls: "warn" },
  none: { label: "None collected", cls: "bad" },
  pending: { label: "Pending", cls: "pending" },
  none_prescribed: { label: "—", cls: "pending" },
};

export default function MedicineCollectionPage() {
  const [tab, setTab] = useState("mark"); // mark | report
  const [date, setDate] = useState(todayISO());
  const [filter, setFilter] = useState("");
  const [patients, setPatients] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selected, setSelected] = useState(null); // patient_id
  const [meds, setMeds] = useState([]);
  const [marks, setMarks] = useState({}); // medication_id -> {status, reason, qty_note}
  const [loadingMeds, setLoadingMeds] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(() => {
    setLoadingList(true);
    api
      .get(`/api/pharmacy/collection/today?date=${date}`)
      .then((r) => setPatients(r.data?.patients || []))
      .catch(() => setPatients([]))
      .finally(() => setLoadingList(false));
  }, [date]);
  useEffect(loadList, [loadList]);

  const openPatient = (pid) => {
    setSelected(pid);
    setLoadingMeds(true);
    api
      .get(`/api/patients/${pid}/collection?date=${date}`)
      .then((r) => {
        const list = r.data?.medicines || [];
        setMeds(list);
        const m = {};
        for (const x of list)
          if (x.status)
            m[x.medication_id] = {
              status: x.status,
              reason: x.reason || "",
              qty_note: x.qty_note || "",
            };
        setMarks(m);
      })
      .catch(() => setMeds([]))
      .finally(() => setLoadingMeds(false));
  };

  const setMark = (medId, field, val) =>
    setMarks((p) => ({ ...p, [medId]: { ...(p[medId] || {}), [field]: val } }));

  const markAllGiven = () => {
    const m = {};
    for (const x of meds) m[x.medication_id] = { status: "given", reason: "", qty_note: "" };
    setMarks(m);
  };

  const save = async () => {
    const items = Object.entries(marks)
      .filter(([, v]) => v.status)
      .map(([medication_id, v]) => ({
        medication_id: Number(medication_id),
        status: v.status,
        reason: v.reason || null,
        qty_note: v.qty_note || null,
      }));
    if (!items.length) return toast("Mark at least one medicine", "warn");
    const missing = items.find((i) => i.status !== "given" && !i.reason);
    if (missing) return toast("Pick a reason for not-given / partial medicines", "warn");
    setSaving(true);
    try {
      const r = await api.post(`/api/patients/${selected}/collection/bulk`, { date, items });
      toast(
        r.data?.journey === "stamped"
          ? "Collection saved · journey Rx station marked done"
          : "Collection saved",
        "success",
      );
      loadList();
    } catch (e) {
      toast(e.response?.data?.message || e.response?.data?.error || "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.patient_name?.toLowerCase().includes(q) || (p.file_no || "").toLowerCase().includes(q),
    );
  }, [patients, filter]);

  const selPatient = patients.find((p) => p.patient_id === selected);

  return (
    <div className="medcoll">
      <div className="medcoll-head">
        <h1>💊 Medicine Collection</h1>
        {tab === "mark" && (
          <label className="medcoll-date">
            Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        )}
      </div>

      <div className="medcoll-tabs">
        <button className={tab === "mark" ? "active" : ""} onClick={() => setTab("mark")}>
          Mark Collection
        </button>
        <button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>
          Report
        </button>
      </div>

      {tab === "report" ? (
        <ReportView />
      ) : (
        <>
          <p className="medcoll-hint">
            Patients prescribed medicines on this date. Open a patient and mark each medicine{" "}
            <strong>given</strong>, <strong>not given</strong>, or <strong>partial</strong>.
          </p>

          <div className="medcoll-body">
            {/* ── Worklist ── */}
            <div className="medcoll-list">
              <input
                className="medcoll-filter"
                placeholder="🔍 Filter by name / file no"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {loadingList ? (
                <p className="medcoll-empty">Loading…</p>
              ) : shown.length === 0 ? (
                <p className="medcoll-empty">No patients prescribed on {date}.</p>
              ) : (
                shown.map((p) => {
                  const r = ROLLUP[p.status] || ROLLUP.pending;
                  return (
                    <button
                      key={p.patient_id}
                      className={`medcoll-row ${selected === p.patient_id ? "active" : ""}`}
                      onClick={() => openPatient(p.patient_id)}
                    >
                      <div className="medcoll-row-main">
                        <span className="medcoll-name">{p.patient_name}</span>
                        {p.file_no && <small> {p.file_no}</small>}
                      </div>
                      <div className="medcoll-row-meta">
                        <span className={`medcoll-badge ${r.cls}`}>{r.label}</span>
                        <small>
                          {p.given}/{p.total}
                        </small>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* ── Patient medicines ── */}
            <div className="medcoll-panel">
              {!selected ? (
                <p className="medcoll-empty">Select a patient to mark their medicines.</p>
              ) : loadingMeds ? (
                <p className="medcoll-empty">Loading…</p>
              ) : (
                <>
                  <div className="medcoll-panel-head">
                    <strong>{selPatient?.patient_name}</strong>
                    {selPatient?.doctor_name && <small> · {selPatient.doctor_name}</small>}
                    <button className="medcoll-allbtn" onClick={markAllGiven}>
                      ✓ Mark all given
                    </button>
                  </div>
                  <FlowPanel
                    patientDbId={selected}
                    fileNo={selPatient?.file_no}
                    roleHint="pharmacy"
                  />
                  {meds.length === 0 ? (
                    <p className="medcoll-empty">No current medicines for this patient.</p>
                  ) : (
                    <table className="medcoll-meds">
                      <thead>
                        <tr>
                          <th>Medicine</th>
                          <th>Dose · Freq · Timing</th>
                          <th>Status</th>
                          <th>Reason / note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {meds.map((m) => {
                          const mk = marks[m.medication_id] || {};
                          const blocked = mk.status && mk.status !== "given";
                          return (
                            <tr key={m.medication_id}>
                              <td>
                                <strong>{m.pharmacy_match || m.name}</strong>
                                {m.composition && <small> {m.composition}</small>}
                              </td>
                              <td className="medcoll-dose">
                                {[m.dose, m.frequency, m.timing].filter(Boolean).join(" · ") || "—"}
                              </td>
                              <td>
                                <div className="medcoll-status">
                                  {STATUS.map((s) => (
                                    <label
                                      key={s.v}
                                      className={mk.status === s.v ? `sel ${s.v}` : ""}
                                    >
                                      <input
                                        type="radio"
                                        name={`st-${m.medication_id}`}
                                        checked={mk.status === s.v}
                                        onChange={() => setMark(m.medication_id, "status", s.v)}
                                      />
                                      {s.label}
                                    </label>
                                  ))}
                                </div>
                              </td>
                              <td>
                                {blocked && (
                                  <div className="medcoll-reason">
                                    <select
                                      value={mk.reason || ""}
                                      onChange={(e) =>
                                        setMark(m.medication_id, "reason", e.target.value)
                                      }
                                    >
                                      <option value="">— reason —</option>
                                      {REASONS.map((r) => (
                                        <option key={r.v} value={r.v}>
                                          {r.label}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      placeholder={
                                        mk.status === "partial" ? "e.g. 15 of 30" : "note"
                                      }
                                      value={mk.qty_note || ""}
                                      onChange={(e) =>
                                        setMark(m.medication_id, "qty_note", e.target.value)
                                      }
                                    />
                                  </div>
                                )}
                                {m.marked_at && !mk.status && (
                                  <small className="medcoll-prev">
                                    {m.status} · {m.marked_by || ""}
                                  </small>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {meds.length > 0 && (
                    <button className="medcoll-save" disabled={saving} onClick={save}>
                      {saving ? "Saving…" : "Save collection"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Report (doctors / management) ───────────────────────────────
function ReportView() {
  const ago = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split("T")[0];
  };
  const [sub, setSub] = useState("summary"); // summary | not_collected
  const [from, setFrom] = useState(ago(7));
  const [to, setTo] = useState(todayISO());
  const [doctor, setDoctor] = useState("");
  const [status, setStatus] = useState(""); // "" | all | partial | none
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState(null); // { patient, rows }

  const load = useCallback(() => {
    setLoading(true);
    const qs = `from=${from}&to=${to}`;
    const url =
      sub === "summary"
        ? `/api/pharmacy/collection/report?${qs}${doctor ? `&doctor=${encodeURIComponent(doctor)}` : ""}${status ? `&status=${status}` : ""}`
        : `/api/pharmacy/collection/not-collected?${qs}`;
    api
      .get(url)
      .then((r) => setRows(r.data?.rows || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [sub, from, to, doctor, status]);
  useEffect(load, [load]);

  const openHistory = (patient_id, patient_name) => {
    api
      .get(`/api/patients/${patient_id}/collection/history`)
      .then((r) => setHistory({ name: patient_name, rows: r.data?.history || [] }))
      .catch(() => setHistory({ name: patient_name, rows: [] }));
  };

  return (
    <div>
      <div className="medcoll-tabs medcoll-subtabs">
        <button className={sub === "summary" ? "active" : ""} onClick={() => setSub("summary")}>
          Summary
        </button>
        <button
          className={sub === "not_collected" ? "active" : ""}
          onClick={() => setSub("not_collected")}
        >
          Not collected
        </button>
      </div>

      <div className="medcoll-filters">
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To{" "}
          <input type="date" value={to} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
        </label>
        {sub === "summary" && (
          <>
            <input
              placeholder="Doctor (optional)"
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
            />
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="all">Fully collected</option>
              <option value="partial">Partial</option>
              <option value="none">None collected</option>
            </select>
          </>
        )}
      </div>

      {loading ? (
        <p className="medcoll-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="medcoll-empty">No records for this range.</p>
      ) : sub === "summary" ? (
        <table className="medcoll-meds">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Date</th>
              <th>Doctor</th>
              <th>Collected</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const ru = ROLLUP[r.status] || ROLLUP.pending;
              return (
                <tr key={`${r.patient_id}-${r.collected_date}-${i}`}>
                  <td>
                    {r.patient_name}
                    {r.file_no ? <small> {r.file_no}</small> : null}
                  </td>
                  <td>{r.collected_date}</td>
                  <td>{r.doctor_name || "—"}</td>
                  <td>
                    {r.given}/{r.lines}
                    {r.not_given ? ` · ${r.not_given} not given` : ""}
                  </td>
                  <td>
                    <span className={`medcoll-badge ${ru.cls}`}>{ru.label}</span>
                  </td>
                  <td>
                    <button
                      className="medcoll-link"
                      onClick={() => openHistory(r.patient_id, r.patient_name)}
                    >
                      History
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <table className="medcoll-meds">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Medicine</th>
              <th>Date</th>
              <th>Reason</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.patient_name}
                  {r.file_no ? <small> {r.file_no}</small> : null}
                </td>
                <td>{r.pharmacy_match || r.medicine}</td>
                <td>{r.collected_date}</td>
                <td>
                  <span className="medcoll-badge bad">
                    {REASON_LABEL[r.reason] || r.reason || "—"}
                  </span>
                </td>
                <td>{r.phone || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {history && (
        <div className="medcoll-modal-bg" onClick={() => setHistory(null)}>
          <div className="medcoll-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Collection history — {history.name}</h2>
            {history.rows.length === 0 ? (
              <p className="medcoll-empty">No history.</p>
            ) : (
              <table className="medcoll-meds">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Medicine</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((h) => (
                    <tr key={h.id}>
                      <td>{h.collected_date}</td>
                      <td>{h.medicine}</td>
                      <td>
                        <span
                          className={`medcoll-badge ${h.status === "given" ? "ok" : h.status === "partial" ? "warn" : "bad"}`}
                        >
                          {h.status}
                        </span>
                      </td>
                      <td>{REASON_LABEL[h.reason] || h.reason || "—"}</td>
                      <td>{h.marked_by || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button className="medcoll-link" onClick={() => setHistory(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
