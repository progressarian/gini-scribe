import { useEffect, useMemo, useState } from "react";
import { CATEGORY_META, consultStarted } from "../../../../shared/giniflowStatus";
import { useConsultFee } from "../../../queries/hooks/useGiniflowTriage";
import { consultFeeText } from "../../../lib/consultFeeText";

// The coordinator's one dialog: which column this patient belongs in, and who
// is going to work them. Both in one place because they are one decision — the
// category IS the answer to "does the doctor need to see them" (§4.2).
//
// An override is stamped as the coordinator's and survives every later run of
// the auto engine, so the dialog says so out loud and offers the way back:
// "Hand back to auto" clears the source and lets the sweep re-decide.

const initials = (name = "") =>
  name
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

export const rxMosForDoctor = (staff, doctorId, rxMoId) =>
  (staff || []).filter(
    (p) =>
      String(p.role || "").toLowerCase() === "rx_mo" &&
      ((doctorId && p.assistsDoctorId === doctorId) || p.id === rxMoId),
  );

const byLoadThenName = (a, b) =>
  b.assignedToday - a.assignedToday || a.shortName.localeCompare(b.shortName);

function StaffPicker({ label, people, value, open, onOpen, onClose, onPick, disabled, chiefTag }) {
  const [q, setQ] = useState("");
  const chosen = people.find((p) => p.id === value) || null;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return people
      .filter(
        (p) =>
          !needle ||
          p.shortName.toLowerCase().includes(needle) ||
          String(p.name || "")
            .toLowerCase()
            .includes(needle) ||
          String(p.specialty || "")
            .toLowerCase()
            .includes(needle),
      )
      .sort(byLoadThenName);
  }, [people, q]);

  const pick = (id) => {
    onPick(id);
    setQ("");
    onClose();
  };

  return (
    <div className="sp">
      <p className="dlg-label">{label}</p>
      <button
        type="button"
        className={`sp-trigger${chosen ? " set" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span className="sd-av">{chosen ? initials(chosen.shortName) : "—"}</span>
        <span className="sd-info">
          <span className="sd-name">
            {chosen ? chosen.shortName : "Not assigned"}
            {chosen && chiefTag && chosen.isChief ? " · chief" : ""}
          </span>
          {chosen && (
            <span className="sd-detail">
              {chosen.specialty || chosen.role || "clinician"} · {chosen.assignedToday} today
            </span>
          )}
        </span>
        <span className="sp-caret">{disabled ? "🔒" : open ? "▴" : "Change ▾"}</span>
      </button>
      {open && (
        <div className="sp-panel">
          <input
            type="search"
            className="sp-search"
            placeholder="Search by name or specialty"
            aria-label={`Search ${label}`}
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                e.preventDefault();
                pick(shown[0].id);
              }
            }}
          />
          <div className="sp-list" role="listbox" aria-label={label}>
            {value && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="sp-opt clear"
                onClick={() => pick(null)}
              >
                ✕ Remove {chosen?.shortName || "assignment"}
              </button>
            )}
            {shown.map((p) => (
              <button
                type="button"
                role="option"
                aria-selected={p.id === value}
                key={p.id}
                className={`sp-opt${p.id === value ? " sel" : ""}`}
                onClick={() => pick(p.id)}
              >
                <span className="sp-opt-name">
                  {p.shortName}
                  {chiefTag && p.isChief ? " · chief" : ""}
                </span>
                <span className="sp-opt-meta">{p.specialty || p.role || ""}</span>
                <span className={`sp-load${p.assignedToday ? " busy" : ""}`}>
                  {p.assignedToday} today
                </span>
              </button>
            ))}
            {shown.length === 0 && <p className="sp-empty">No doctor matches “{q}”.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function RxMoChips({ people, value, onPick, disabled }) {
  return (
    <div className="rxmo-chips" role="group" aria-label="MO writing the prescription">
      {people.map((p) => (
        <button
          type="button"
          key={p.id}
          className={`rxmo-chip${p.id === value ? " sel" : ""}`}
          aria-pressed={p.id === value}
          disabled={disabled}
          title={
            p.id === value ? `Remove ${p.shortName}` : `${p.shortName} writes the prescription`
          }
          onClick={() => onPick(p.id === value ? null : p.id)}
        >
          {p.id === value ? "✓ " : ""}
          {p.shortName.replace(/^Dr\.?\s+/i, "")}
          <span className="rxmo-load">{p.assignedToday}</span>
        </button>
      ))}
    </div>
  );
}

export default function AssignMenu({ card, staff, saving, onClose, onSave, onReset }) {
  const [category, setCategory] = useState(card.category);
  const [sdId, setSdId] = useState(card.assignment.sdId);
  const [doctorId, setDoctorId] = useState(card.assignment.doctorId);
  const [rxMoId, setRxMoId] = useState(card.assignment.rxMoId ?? null);
  const [openPicker, setOpenPicker] = useState(null);
  const isRxMo = (p) => String(p.role || "").toLowerCase() === "rx_mo";
  const clinicians = (staff || []).filter((p) => !isRxMo(p));
  const consultants = clinicians.filter(
    (p) => p.isChief || String(p.role || "").toLowerCase() !== "mo",
  );
  const rxMos = rxMosForDoctor(staff, doctorId, rxMoId);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (openPicker) setOpenPicker(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openPicker]);

  const dirty =
    category !== card.category ||
    sdId !== card.assignment.sdId ||
    doctorId !== card.assignment.doctorId ||
    rxMoId !== (card.assignment.rxMoId ?? null);

  const consultLocked = consultStarted(card.status);
  const changingDoctor = Boolean(doctorId) && doctorId !== card.assignment.doctorId;
  const fee = useConsultFee(card.visitId, doctorId, changingDoctor);
  const chosenName =
    (staff || []).find((p) => p.id === doctorId)?.shortName || "The new consultant";

  return (
    <div className="tmodal open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tbox assign-box" role="dialog" aria-label={`Triage ${card.name}`}>
        <div className="tb-hd">
          <div>
            <div className="tb-name">{card.name}</div>
            <div className="tb-meta">
              {card.age ?? "—"}
              {(card.sex || "")[0] || ""} · {card.fileNo} ·{" "}
              {card.isNewPatient ? "first visit" : `visit ${card.visitNumber}`} ·{" "}
              {card.slot || "no slot"}
            </div>
          </div>
          <button className="tb-cls" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tb-body">
          <p className="dlg-label">Category</p>
          <div className="cat-grid">
            {Object.entries(CATEGORY_META).map(([key, meta]) => (
              <button
                type="button"
                key={key}
                className={`cat-opt${category === key ? " sel" : ""}`}
                onClick={() => setCategory(key)}
              >
                {meta.icon} {meta.short}
                <small>{meta.lead}</small>
              </button>
            ))}
          </div>
          <p className="dlg-note">
            {card.categorySource === "coordinator"
              ? `Set by hand${card.categorySetBy ? ` — ${card.categorySetBy}` : ""}. The automatic sweep leaves it alone.`
              : "Set automatically from HbA1c. Changing it here makes it yours, and the sweep will not overwrite it again."}
          </p>

          <div className="sp-row">
            <StaffPicker
              label="Chief Endocrinologist who leads the workup"
              people={clinicians}
              value={sdId}
              open={openPicker === "sd"}
              onOpen={() => setOpenPicker("sd")}
              onClose={() => setOpenPicker(null)}
              onPick={setSdId}
            />
            <StaffPicker
              label="Consultant who sees them"
              people={consultants}
              value={doctorId}
              open={openPicker === "doctor"}
              onOpen={() => setOpenPicker("doctor")}
              onClose={() => setOpenPicker(null)}
              onPick={setDoctorId}
              disabled={consultLocked}
              chiefTag
            />
          </div>

          {rxMos.length > 0 && (
            <div className="sp">
              <p className="dlg-label">MO writing the prescription</p>
              <RxMoChips people={rxMos} value={rxMoId} onPick={setRxMoId} />
            </div>
          )}

          {consultLocked && (
            <p className="dlg-note">
              {card.assignment.doctorName || "The consultant"} has started the consult, so the
              consultant can't be changed now.
            </p>
          )}
          {changingDoctor && (
            <p className="dlg-note" role="status">
              {fee.isLoading
                ? "Checking the consultation fee…"
                : fee.isError
                  ? "The consultation fee could not be checked — the counter will settle any difference."
                  : fee.data && consultFeeText(fee.data, chosenName)}
            </p>
          )}

          <div className="cf-actions assign-actions">
            {card.categorySource === "coordinator" && (
              <button
                className="btn btn-g"
                onClick={onReset}
                disabled={saving}
                title="Clear the override and let the engine decide again"
              >
                Hand back to auto
              </button>
            )}
            <button className="btn btn-g" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn btn-tl"
              disabled={!dirty || saving}
              onClick={() => onSave({ category, sdId, doctorId, rxMoId })}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
