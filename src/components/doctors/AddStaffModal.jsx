import { useEffect, useRef, useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import { normalizeRole } from "../../../shared/permissions";
import { STAFF_ROLE_LABELS } from "../../../shared/staffRoles";

const ROLE_OPTIONS = Object.entries(STAFF_ROLE_LABELS).filter(
  ([role]) => role !== "guest" && normalizeRole(role) === role,
);

const EMPTY = { name: "", role: "consultant", specialty: "", short_name: "", phone: "", pin: "" };

const problemsOf = (f) => {
  const out = {};
  if (!f.name.trim()) out.name = "Enter the staff member's full name.";
  if (!f.role) out.role = "Choose a role.";
  if (!/^\d{4}$/.test(f.pin)) out.pin = "Enter a 4-digit PIN they will log in with.";
  if (f.phone && !/^\d{10}$/.test(f.phone)) out.phone = "Enter a 10-digit mobile number.";
  return out;
};

export default function AddStaffModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef(null);
  const problems = problemsOf(form);
  const show = (k) => (touched ? problems[k] : null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      const { data } = await api.post("/api/doctors", {
        name: form.name.trim(),
        role: form.role,
        specialty: form.specialty.trim() || null,
        short_name: form.short_name.trim() || null,
        phone: form.phone || null,
        pin: form.pin,
      });
      toast(`${data.name} added as ${STAFF_ROLE_LABELS[data.role] || data.role}`, "success");
      await onCreated(data);
    } catch (err) {
      toast(err.response?.data?.error || "Could not add this staff member. Try again.", "error");
    } finally {
      setBusy(false);
    }
  };

  const field = (k, label, input, hint) => (
    <label className="docmgmt-field">
      <span>{label}</span>
      {input}
      {show(k) ? (
        <span className="docmgmt-fielderr" id={`addstaff-${k}-err`}>
          {show(k)}
        </span>
      ) : (
        hint && <span className="docmgmt-hint">{hint}</span>
      )}
    </label>
  );
  const invalid = (k) => ({
    "aria-invalid": show(k) ? true : undefined,
    "aria-describedby": show(k) ? `addstaff-${k}-err` : undefined,
  });

  return (
    <div className="docmgmt-modal-bg" onClick={() => !busy && onClose()}>
      <form
        className="docmgmt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docmgmt-addstaff-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        noValidate
      >
        <h2 id="docmgmt-addstaff-title">Add staff member</h2>
        <p className="docmgmt-hint">
          They can log in with this PIN straight away. Consultants and MOs start with no weekly
          schedule — set it on their Schedule tab.
        </p>
        <div className="docmgmt-fields">
          {field(
            "name",
            "Full name (required)",
            <input ref={firstRef} value={form.name} onChange={set("name")} {...invalid("name")} />,
          )}
          {field(
            "role",
            "Role (required)",
            <select value={form.role} onChange={set("role")} {...invalid("role")}>
              {ROLE_OPTIONS.map(([role, label]) => (
                <option key={role} value={role}>
                  {label}
                </option>
              ))}
            </select>,
          )}
          {field(
            "specialty",
            "Specialty",
            <input value={form.specialty} onChange={set("specialty")} />,
            "e.g. Endocrinology",
          )}
          {field(
            "short_name",
            "Short name",
            <input value={form.short_name} onChange={set("short_name")} />,
            "As written on bookings, e.g. Dr Bhansali",
          )}
          {field(
            "phone",
            "Mobile",
            <input
              inputMode="numeric"
              maxLength={10}
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value.replace(/\D/g, "") }))}
              {...invalid("phone")}
            />,
          )}
          {field(
            "pin",
            "Login PIN (required)",
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={form.pin}
              onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, "") }))}
              {...invalid("pin")}
            />,
            "4 digits. Share it with them privately.",
          )}
        </div>
        <div className="docmgmt-modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="docmgmt-primary" disabled={busy}>
            {busy ? "Adding…" : "Add staff member"}
          </button>
        </div>
      </form>
    </div>
  );
}
