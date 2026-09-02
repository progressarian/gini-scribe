import { useEffect, useMemo, useRef, useState } from "react";
import {
  useVitalsQueue,
  useVitalsPatient,
  useSaveVitals,
  useStartVitals,
  useReleaseVitals,
} from "../../queries/hooks/useGiniflowVitals";
import { useVoiceVitals } from "../../hooks/useVoiceVitals";
import { SPOKEN_EXAMPLE, flagLargeChanges } from "../../../shared/giniflowVitalsSpeech";
import { useTick, minutesSince, budgetColour } from "../../lib/giniflowTime";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import "../../styles/giniflow-station.css";

const CATEGORY_BADGE = {
  worse_out_of_range: { cls: "b-red", label: "🔴 Red" },
  worse_in_range: { cls: "b-amb", label: "🟠 Amber" },
  getting_better: { cls: "b-amb", label: "🟡 Getting better" },
  in_control: { cls: "b-grn", label: "✅ Green" },
  no_reports: { cls: "b-blu", label: "🔵 No reports" },
};

// Physiological bounds, matching the server's Zod schema. A typo here becomes a
// number a doctor may act on, so the field says so before the save is allowed.
const BOUNDS = {
  weight: [1, 400],
  height: [30, 260],
  bpSys: [50, 300],
  bpDia: [20, 200],
  pulse: [20, 250],
  spo2: [50, 100],
  temp: [90, 115],
};

const EMPTY = { weight: "", height: "", bpSys: "", bpDia: "", pulse: "", spo2: "", temp: "" };

const FIELD_LABEL = {
  weight: "weight",
  height: "height",
  bpSys: "BP",
  bpDia: "BP",
  pulse: "pulse",
  spo2: "SpO2",
  temp: "temperature",
};

// "weight and BP", not "weight, bpSys, bpDia" — and never a bare list ending in
// a comma.
const nameList = (fields) => {
  const names = [...new Set(fields.map((f) => FIELD_LABEL[f] || f))];
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

// Height rarely changes and temperature is not always taken, so neither is
// treated as a gap worth chasing out loud.
const EXPECTED_SPOKEN = ["weight", "bpSys", "bpDia", "pulse", "spo2"];

const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

const outOfRange = (field, value) => {
  const n = num(value);
  if (n === null || Number.isNaN(n)) return value !== "";
  const [lo, hi] = BOUNDS[field];
  return n < lo || n > hi;
};

const PRIORITY_CHIP = {
  urgent: { cls: "pri-urgent", label: "❗ Urgent" },
  high: { cls: "pri-high", label: "⬆ High" },
};

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : null;

// The screen top to bottom, in the order the station reads it. Several staff
// work this station at once, so "at the station" is a group rather than a
// single "Now" row — each colleague has their own patient in front of them.
const SECTIONS = [
  { key: "atStation", icon: "🟢", title: "At the station", sub: "being seen now" },
  { key: "waiting", icon: "⏳", title: "Waiting", sub: "ready to call" },
  { key: "held", icon: "🚫", title: "Held", sub: "cannot be called" },
  { key: "moved", icon: "➡️", title: "Vitals done", sub: "still on the floor", done: true },
  { key: "exited", icon: "✅", title: "Finished and left", sub: "", done: true },
];

// A group heading that opens and closes its own section. A real button inside
// the heading, so it keeps heading semantics for a screen reader and states
// whether the section is open.
function GroupHead({ icon, title, sub, count, open, onToggle, id }) {
  return (
    <h2 className="sq-gh">
      <button
        type="button"
        className="sq-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span aria-hidden="true">{icon}</span> {title}
        {sub && <span className="sq-ghsub">— {sub}</span>}
        <span className="sq-count">{count}</span>
      </button>
    </h2>
  );
}

// A patient the station can act on: at the station, or waiting to be called.
function QueueRow({ q, active, now, onPick }) {
  const waited = minutesSince(q.statusSince, now) ?? q.waitMinutes ?? 0;
  const tone = budgetColour(waited, q.waitBudget);
  const chip = PRIORITY_CHIP[q.priority];
  return (
    <button
      type="button"
      className={`sq-item${active ? " active" : ""}${chip ? ` ${chip.cls}` : ""}`}
      onClick={() => onPick(q.visitId)}
    >
      <div className="si-slot">{q.slot}</div>
      <div className="si-name">
        {q.name}
        {chip && <span className={`si-pri ${chip.cls}`}>{chip.label}</span>}
      </div>
      <div className="si-meta">
        {q.age}
        {(q.sex || "")[0] || ""} · {q.fileNo} · Visit {q.visitNumber}
        {CATEGORY_BADGE[q.category] ? ` · ${CATEGORY_BADGE[q.category].label}` : ""}
      </div>
      {/* The wait is what the station can act on, so it reads before the
          biomarkers, and the words say which clock it is: time at the station
          once they have sat down, time queueing until then. */}
      <div className="si-wait">
        <span className={`si-tmr si-tmr-${tone}`}>
          ⏱ {waited}m {q.status === "with_vitals" ? "at station" : "waiting"}
        </span>
        {q.checkedInAt && <span className="si-since">in since {clock(q.checkedInAt)}</span>}
      </div>
      {q.priorityReason && <div className="si-reason">❗ {q.priorityReason}</div>}
      {q.bios?.length > 0 && (
        <div className="si-bios">
          {q.bios.map((b) => (
            <span key={b.label} className={`sbio sbio-${b.tone}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// A patient whose vitals are recorded. Tapping reopens the reading — saveVitals
// stores a correction without walking them back through the chain, so this
// needs no new write path.
function DoneRow({ d, active, onPick }) {
  return (
    <button
      type="button"
      className={`sq-done${active ? " active" : ""}`}
      onClick={() => onPick(d.visitId)}
    >
      <div className="si-name">{d.name}</div>
      <div className="si-meta">
        {clock(d.recordedAt)} · {d.bp ? `BP ${d.bp}` : "BP —"}
        {d.weight ? ` · ${d.weight} kg` : ""}
      </div>
      <div className="si-nowat">now: {d.nowAt}</div>
    </button>
  );
}

export default function VitalsStationPage() {
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [toast, setToast] = useState("");
  const [spokeAnything, setSpokeAnything] = useState(false);
  const [rechecked, setRechecked] = useState(false);
  const [search, setSearch] = useState("");
  // The two history groups start closed: they are a record of work already
  // done, and on a full day they are the longest lists on the screen. The two
  // groups the station acts on must not sit below fifty rows of history.
  const [collapsed, setCollapsed] = useState(() => new Set(["moved", "exited"]));
  const toastTimer = useRef(null);

  const toggleGroup = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const now = useTick();
  const { data: queueData, isLoading } = useVitalsQueue();
  const live = useGiniflowLive({ date: queueData?.date });
  const saveVitals = useSaveVitals();
  const startVitals = useStartVitals();
  const releaseVitals = useReleaseVitals();

  // Filtered client-side: the whole day is already in this response, so the
  // search is instant and costs no round trip. The server filters the
  // consultant's queue instead only because that one pages.
  const term = search.trim().toLowerCase();
  const matches = (r) =>
    !term ||
    (r.name || "").toLowerCase().includes(term) ||
    (r.fileNo || "").toLowerCase().includes(term);

  const atStation = (queueData?.atStation || []).filter(matches);
  const waitingList = (queueData?.waiting || []).filter(matches);
  const held = (queueData?.held || []).filter(matches);
  const moved = (queueData?.moved || []).filter(matches);
  const exited = (queueData?.exited || []).filter(matches);
  // Everyone the station can still claim. Searching must not change who can be
  // claimed, so this reads the unfiltered response.
  const queue = [...(queueData?.atStation || []), ...(queueData?.waiting || [])];
  const totalShown =
    atStation.length + waitingList.length + held.length + moved.length + exited.length;

  // Derived, not set in an effect: the screen opens on whoever is at the station
  // with no click and no flash of the empty state.
  const activeVisitId = selected ?? queue[0]?.visitId ?? null;
  // A patient reopened from the done list has already left the station, and
  // saveVitals will store the correction without moving them. The bar must say
  // that rather than promising to send them on again.
  const correcting = !!activeVisitId && !queue.some((q) => q.visitId === activeVisitId);
  const { data: patient } = useVitalsPatient(activeVisitId);

  // A different patient means a fresh form — never carry one patient's numbers
  // onto another's record.
  useEffect(() => {
    if (!patient) return;
    const r = patient.recorded;
    setForm(
      r
        ? {
            weight: r.weight ?? "",
            height: r.height ?? "",
            bpSys: r.bp_sys ?? "",
            bpDia: r.bp_dia ?? "",
            pulse: r.pulse ?? "",
            spo2: r.spo2 ?? "",
            temp: r.temp ?? "",
          }
        : { ...EMPTY, height: patient.lastVisit?.height ?? "" },
    );
    setSpokeAnything(false);
    setRechecked(false);
  }, [patient?.visitId, patient?.recorded, patient?.lastVisit?.height]);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  // Voice fills the fields it heard and leaves the rest alone, so a nurse can
  // speak the four common readings and type the two that vary.
  const voice = useVoiceVitals({
    onFields: (values) => {
      setForm((f) => {
        const next = { ...f };
        for (const [k, v] of Object.entries(values)) next[k] = String(v);
        return next;
      });
      setSpokeAnything(true);
    },
  });

  const bmi = useMemo(() => {
    const w = num(form.weight);
    const h = num(form.height);
    if (!w || !h) return null;
    return (w / (h / 100) ** 2).toFixed(1);
  }, [form.weight, form.height]);

  const last = patient?.lastVisit;
  const weightDelta = useMemo(() => {
    const w = num(form.weight);
    if (!w || !last?.weight) return null;
    const d = w - Number(last.weight);
    if (Math.abs(d) < 0.05) return "same as last visit";
    return `${d > 0 ? "↑" : "↓"} ${Math.abs(d).toFixed(1)} kg from last visit`;
  }, [form.weight, last]);

  const selectedId = activeVisitId;

  // What voice heard but the form still lacks — recomputed from the form, so
  // typing a missing value makes the prompt disappear.
  const stillMissing = voice.result
    ? EXPECTED_SPOKEN.filter((f) => form[f] === "" || form[f] === null || form[f] === undefined)
    : [];

  // A reading can be plausible and still wrong. Flag anything that has moved a
  // long way since the last visit and make the nurse acknowledge it.
  const changeFlags = flagLargeChanges(
    Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === "" ? null : Number(v)])),
    last,
  );

  const invalid = Object.keys(BOUNDS).filter((f) => form[f] !== "" && outOfRange(f, form[f]));
  const anyEntered = Object.values(form).some((v) => v !== "");
  const needsRecheck = changeFlags.length > 0 && !rechecked;
  const canSave = anyEntered && invalid.length === 0 && !needsRecheck && !saveVitals.isPending;

  // Claiming the station only makes sense for someone still in the queue.
  // Tapping a patient in the done list opens their reading for correction — it
  // must not walk them back to "at vitals" from wherever they have got to.
  const pick = (visitId) => {
    if (!queue.some((q) => q.visitId === visitId)) {
      setSelected(visitId);
      return;
    }
    // Selection follows the claim rather than leading it: when the station is
    // already holding someone the claim is refused, and the panel must stay on
    // the patient in the chair instead of opening a form for one who is not.
    startVitals.mutate(visitId, {
      onSuccess: () => setSelected(visitId),
      onError: (e) => showToast(e?.response?.data?.error || "Could not start this patient"),
    });
  };

  const sendBackToQueue = () => {
    const name = patient?.name?.split(" ")[0] || "Patient";
    releaseVitals.mutate(selectedId, {
      onSuccess: () => {
        setSelected(null);
        showToast(`${name} sent back to the queue`);
      },
      onError: (e) => showToast(e?.response?.data?.error || "Could not send them back"),
    });
  };

  const submit = () => {
    saveVitals.mutate(
      {
        visitId: selectedId,
        weight: num(form.weight),
        height: num(form.height),
        bpSys: num(form.bpSys),
        bpDia: num(form.bpDia),
        pulse: num(form.pulse),
        spo2: num(form.spo2),
        temp: num(form.temp),
        source: spokeAnything ? "voice" : "manual",
      },
      {
        onSuccess: () => {
          showToast(`✓ ${patient?.name?.split(" ")[0] || "Patient"} moved to the MO queue`);
          // Auto-advance to the next patient, as the prototype does.
          const next = queue.find((q) => q.visitId !== selectedId);
          setSelected(next ? next.visitId : null);
        },
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not save — nothing was recorded"),
      },
    );
  };

  const badge = CATEGORY_BADGE[patient?.category] || null;

  return (
    <div className="gf">
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--blu-l)", color: "var(--blu)" }}>
          ⚖️ Vitals Station
        </div>
        <div className="rail-right">
          <span className="badge b-blu">{queue.length} in queue</span>
          <span className="badge b-grn">{queueData?.doneToday ?? 0} done today</span>
          {/* A real link, not a router push: this is navigation to another page,
              it works without JS, and it keeps the station screen free of a
              router dependency. */}
          <LiveBadge live={live} className="tr-live" />
          <a className="tr-back" href="/giniflow/manager">
            ← Board
          </a>
        </div>
      </div>

      <div className="station-layout">
        <div className="squeue">
          <div className="sq-header">
            <div className="sq-title">Vitals queue</div>
            <div className="sq-sub">Tap patient to start</div>
            <input
              className="sq-search"
              type="search"
              value={search}
              placeholder="Search name or file no…"
              aria-label="Search today's patients"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {isLoading && <div className="sq-foot">Loading…</div>}
          {!isLoading && totalShown === 0 && (
            <div className="sq-foot">
              {term ? `Nobody matches “${search.trim()}”.` : "Nobody at this station today."}
            </div>
          )}

          {SECTIONS.map((g) => {
            const rows = {
              atStation,
              waiting: waitingList,
              held,
              moved,
              exited,
            }[g.key];
            if (!rows.length) return null;
            // A search that matches inside a closed group would hide its own
            // results, so searching opens every group that has a hit.
            const open = !!term || !collapsed.has(g.key);
            const id = `sq-group-${g.key}`;
            return (
              <div className="sq-sect" key={g.key}>
                <GroupHead
                  icon={g.icon}
                  title={g.title}
                  sub={g.sub}
                  count={rows.length}
                  open={open}
                  onToggle={() => toggleGroup(g.key)}
                  id={id}
                />
                <div id={id} hidden={!open}>
                  {g.key === "held"
                    ? rows.map((h) => (
                        <div className="sq-held" key={h.visitId}>
                          <div className="si-name">{h.name}</div>
                          <div className="si-meta">
                            {h.age}
                            {(h.sex || "")[0] || ""} · {h.fileNo}
                          </div>
                          <div className="si-reason">🚫 {h.blockedReason || "On hold"}</div>
                        </div>
                      ))
                    : g.done
                      ? rows.map((d) => (
                          <DoneRow
                            key={`${d.visitId}-${d.recordedAt}`}
                            d={d}
                            active={d.visitId === activeVisitId}
                            onPick={pick}
                          />
                        ))
                      : rows.map((q) => (
                          <QueueRow
                            key={q.visitId}
                            q={q}
                            now={now}
                            active={q.visitId === activeVisitId}
                            onPick={pick}
                          />
                        ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="station-detail">
          {!patient && <div className="sd-empty">Select a patient from the queue.</div>}
          {patient && (
            <>
              <div className="sd-header">
                <div className="sdh-body">
                  <div className="sdh-name">{patient.name}</div>
                  <div className="sdh-meta">
                    {patient.age}
                    {(patient.sex || "")[0] || ""} · {patient.fileNo} · Visit {patient.visitNumber}
                    {clock(patient.checkedInAt)
                      ? ` · Checked in ${clock(patient.checkedInAt)}`
                      : ""}
                  </div>
                </div>
                <div className="sdh-acts">
                  {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
                  {/* The chair holds one patient, so there has to be a way to
                      give it up without recording a reading — the patient who
                      got up, or the wrong row tapped. */}
                  {!correcting && (
                    <button
                      type="button"
                      className="tr-back"
                      onClick={sendBackToQueue}
                      disabled={releaseVitals.isPending}
                    >
                      {releaseVitals.isPending ? "Sending…" : "← Back to queue"}
                    </button>
                  )}
                </div>
              </div>

              <div className="sd-body">
                <div className="voice-bar">
                  <button
                    className={`voice-pill${voice.listening ? " listening" : ""}`}
                    onClick={voice.toggle}
                    disabled={voice.busy}
                  >
                    <span className="voice-dot" />{" "}
                    {voice.busy ? "Reading back…" : voice.listening ? "Stop" : "Speak vitals"}
                  </button>
                  <div className="vb-desc">
                    {voice.listening ? (
                      <>
                        <strong>Listening…</strong>{" "}
                        {voice.live
                          ? "say it in one go — the words appear below as you speak."
                          : "say it in one go, then press Stop."}
                      </>
                    ) : (
                      <>
                        <strong>Just say it:</strong> "{SPOKEN_EXAMPLE}" — the fields fill
                        themselves. Check them before pressing Done.
                      </>
                    )}
                  </div>
                </div>

                {/* The live caption: what the recogniser is hearing, right now. A
                    wrong number is visible while the nurse is still speaking,
                    instead of after the form has been filled from it. */}
                {(voice.listening || voice.caption) && (
                  <div className={`caption${voice.listening ? " live" : ""}`}>
                    {voice.listening && <span className="cap-dot" />}
                    <span className="cap-text">
                      {voice.caption ||
                        (voice.live ? "Listening…" : "Recording — press Stop when done")}
                    </span>
                    {!voice.listening && (
                      <button className="cap-clear" onClick={voice.clear} aria-label="Clear">
                        ✕
                      </button>
                    )}
                  </div>
                )}

                {voice.error && <div className="voice-note voice-err">⚠ {voice.error}</div>}

                {voice.result && (
                  <div className="voice-note">
                    <div className="vn-detail">
                      {voice.result.filled.length ? (
                        <>
                          Filled <strong>{nameList(voice.result.filled)}</strong>.
                        </>
                      ) : (
                        "No readings recognised — type them instead."
                      )}{" "}
                      {stillMissing.length > 0 && (
                        <>
                          Didn’t catch <strong>{nameList(stillMissing)}</strong> — say it or type
                          it.
                        </>
                      )}
                      {voice.result.rejected.length > 0 && (
                        <>
                          {" "}
                          Ignored{" "}
                          {voice.result.rejected
                            .map((r) => `${r.field} "${r.heard}"`)
                            .join(", ")}{" "}
                          as a mishearing.
                        </>
                      )}
                    </div>
                  </div>
                )}

                {last ? (
                  <div className="last-visit">
                    Last visit:{" "}
                    <strong>
                      {[
                        last.weight != null ? `Weight ${Number(last.weight).toFixed(1)} kg` : null,
                        last.bp_sys && last.bp_dia ? `BP ${last.bp_sys}/${last.bp_dia}` : null,
                        last.pulse != null ? `Pulse ${last.pulse}` : null,
                        last.spo2 != null ? `SpO2 ${last.spo2}%` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "no readings recorded"}
                    </strong>
                  </div>
                ) : (
                  <div className="last-visit">No previous vitals on record for this patient.</div>
                )}

                <div className="vitals-grid">
                  <div className="vf">
                    <div className="vf-lbl">Weight (kg)</div>
                    <input
                      className={`vf-inp${outOfRange("weight", form.weight) ? " bad" : form.weight ? " ok" : ""}`}
                      type="number"
                      step="0.1"
                      inputMode="decimal"
                      value={form.weight}
                      onChange={set("weight")}
                    />
                    <div className="vf-unit">{weightDelta || "kg"}</div>
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Height (cm)</div>
                    <input
                      className={`vf-inp${outOfRange("height", form.height) ? " bad" : form.height ? " ok" : ""}`}
                      type="number"
                      inputMode="decimal"
                      value={form.height}
                      onChange={set("height")}
                    />
                    <div className="vf-unit">{bmi ? `BMI auto: ${bmi}` : "cm"}</div>
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Blood pressure</div>
                    <div className="vf-bp">
                      <input
                        className={`vf-inp${outOfRange("bpSys", form.bpSys) ? " bad" : ""}`}
                        type="number"
                        inputMode="numeric"
                        placeholder="Sys"
                        style={{ flex: 1 }}
                        value={form.bpSys}
                        onChange={set("bpSys")}
                      />
                      <span>/</span>
                      <input
                        className={`vf-inp${outOfRange("bpDia", form.bpDia) ? " bad" : ""}`}
                        type="number"
                        inputMode="numeric"
                        placeholder="Dia"
                        style={{ flex: 1 }}
                        value={form.bpDia}
                        onChange={set("bpDia")}
                      />
                    </div>
                    <div className="vf-unit">
                      mmHg{last?.bp_sys ? ` · Last: ${last.bp_sys}/${last.bp_dia}` : ""}
                    </div>
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Pulse (bpm)</div>
                    <input
                      className={`vf-inp${outOfRange("pulse", form.pulse) ? " bad" : ""}`}
                      type="number"
                      inputMode="numeric"
                      placeholder="e.g. 82"
                      value={form.pulse}
                      onChange={set("pulse")}
                    />
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">SpO2 (%)</div>
                    <input
                      className={`vf-inp${outOfRange("spo2", form.spo2) ? " bad" : ""}`}
                      type="number"
                      inputMode="numeric"
                      placeholder="e.g. 98"
                      value={form.spo2}
                      onChange={set("spo2")}
                    />
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Temperature (°F)</div>
                    <input
                      className={`vf-inp${outOfRange("temp", form.temp) ? " bad" : ""}`}
                      type="number"
                      step="0.1"
                      inputMode="decimal"
                      placeholder="98.6"
                      value={form.temp}
                      onChange={set("temp")}
                    />
                  </div>
                </div>

                {changeFlags.length > 0 && (
                  <div className={`recheck${rechecked ? " done" : ""}`}>
                    <div className="rc-body">
                      <div className="rc-title">
                        ⚠ Large change — recheck {nameList(changeFlags.map((f) => f.field))}
                      </div>
                      <div className="rc-detail">
                        {changeFlags.map((f) => (
                          <span key={f.field}>
                            {f.label} was{" "}
                            {f.field === "bpSys" || f.field === "bpDia"
                              ? `${last?.bp_sys}/${last?.bp_dia}`
                              : `${f.was}${f.unit}`}{" "}
                            last visit, now{" "}
                            {f.field === "bpSys" || f.field === "bpDia"
                              ? `${form.bpSys || "—"}/${form.bpDia || "—"}`
                              : `${f.now}${f.unit}`}
                            .{" "}
                          </span>
                        ))}
                        Take it again before moving the patient on.
                      </div>
                    </div>
                    <button
                      className="rc-btn"
                      onClick={() => setRechecked((r) => !r)}
                      aria-pressed={rechecked}
                    >
                      {rechecked ? "✓ Rechecked" : "I rechecked it"}
                    </button>
                  </div>
                )}

                <div className={`done-bar${canSave ? "" : " pending"}`}>
                  <div className="db-text">
                    <div className="db-title">
                      {invalid.length
                        ? "⚠ Check the highlighted readings"
                        : needsRecheck
                          ? "⚠ Recheck before saving"
                          : anyEntered
                            ? correcting
                              ? "Correcting a recorded reading"
                              : "✓ Vitals done"
                            : "Enter the readings"}
                    </div>
                    <div className="db-sub">
                      {invalid.length
                        ? "A value is outside the plausible range — correct it before saving"
                        : needsRecheck
                          ? "Confirm you have taken the reading again"
                          : correcting
                            ? "Already recorded — saving updates the reading, the patient stays where they are"
                            : "Patient moves to the MO queue automatically"}
                    </div>
                  </div>
                  <button className="db-btn" disabled={!canSave} onClick={submit}>
                    {saveVitals.isPending ? "Saving…" : correcting ? "Save correction" : "Done →"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
