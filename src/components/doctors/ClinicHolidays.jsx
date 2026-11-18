import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../../queries/keys";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../ui/ConfirmModal";
import { countDays } from "../crm/daysOff/dayOffText.js";
import { CLINIC_HOLIDAY_LIMITS, holidayTitleError } from "../../../shared/clinicHolidays";

const EMPTY = { title: "", from: "", to: "" };
const VIEWS = [
  ["upcoming", "Upcoming"],
  ["past", "Past"],
];

const dayLabel = (day) =>
  new Date(`${day}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const rangeLabel = (from, to) =>
  from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const errorOf = (e, fallback) => e?.response?.data?.error || fallback;

function validate(form, limits) {
  const errors = {};
  const titleError = holidayTitleError(form.title);
  if (titleError) errors.title = titleError;
  const to = form.to || form.from;
  if (!form.from) errors.from = "Choose the first day.";
  else if (form.from < limits.from || form.from > limits.to) {
    errors.from = `Choose a date from ${dayLabel(limits.from)} to ${dayLabel(limits.to)}.`;
  }
  if (form.from && to < form.from) errors.to = "The last day must be on or after the first day.";
  else if (form.from && to > limits.to) errors.to = `Choose a date up to ${dayLabel(limits.to)}.`;
  else if (form.from && countDays(form.from, to).span > CLINIC_HOLIDAY_LIMITS.maxSpan) {
    errors.to = `Choose ${CLINIC_HOLIDAY_LIMITS.maxSpan} days or fewer at a time.`;
  }
  if (!errors.from && !errors.to && form.from && countDays(form.from, to).working === 0) {
    errors.from = "Pick at least one day that is not a Sunday.";
  }
  return errors;
}

function Field({ id, label, error, children }) {
  return (
    <label htmlFor={id}>
      {label}
      {children}
      {error && (
        <span className="docmgmt-fielderr" id={`${id}-err`}>
          {error}
        </span>
      )}
    </label>
  );
}

export default function ClinicHolidays() {
  const queryClient = useQueryClient();
  const [view, setView] = useState("upcoming");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [bookedNotice, setBookedNotice] = useState(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.clinicHolidays,
    queryFn: () => api.get("/api/clinic-holidays").then((r) => r.data),
  });

  const today = data?.today;
  const holidays = data?.holidays ?? [];
  const grouped = {
    upcoming: holidays.filter((h) => h.day >= today),
    past: holidays.filter((h) => h.day < today).reverse(),
  };
  const rows = grouped[view];
  const to = form.to || form.from;
  const count = form.from && to >= form.from ? countDays(form.from, to) : null;

  const set = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === "from" && (!f.to || f.to < value)) next.to = value;
      return next;
    });
    setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const closeForm = () => {
    setFormOpen(false);
    setForm(EMPTY);
    setErrors({});
  };

  const review = () => {
    if (!data) return;
    const next = validate(form, data.limits);
    setErrors(next);
    if (Object.keys(next).length === 0) {
      setActionError(null);
      setConfirmAdd(true);
    }
  };

  const add = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const { data: result } = await api.post("/api/clinic-holidays", {
        from: form.from,
        to,
        title: form.title.trim(),
      });
      setConfirmAdd(false);
      closeForm();
      setBookedNotice(
        result.booked > 0
          ? `${plural(result.booked, "patient")} already booked on these days. Move or cancel their appointments.`
          : null,
      );
      toast(`${form.title.trim()} added for ${plural(result.days, "day")}.`, "success");
      queryClient.invalidateQueries({ queryKey: qk.clinicHolidays });
    } catch (e) {
      setActionError(errorOf(e, "Could not add the holiday. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.delete(`/api/clinic-holidays/${removing.id}`);
      toast(`${removing.title} on ${dayLabel(removing.day)} removed.`, "success");
      setRemoving(null);
      queryClient.invalidateQueries({ queryKey: qk.clinicHolidays });
    } catch (e) {
      setActionError(errorOf(e, "Could not remove the holiday. Try again."));
      queryClient.invalidateQueries({ queryKey: qk.clinicHolidays });
    } finally {
      setBusy(false);
    }
  };

  const invalid = (key) => ({
    "aria-invalid": Boolean(errors[key]) || undefined,
    "aria-describedby": errors[key] ? `holiday-${key}-err` : undefined,
  });

  return (
    <div>
      <div className="docmgmt-sectionhead">
        <div>
          <p className="docmgmt-hint">
            The clinic is closed for all staff on these days. Booking is blocked, follow-up fee
            windows skip them, and CRM working days leave them out. Sundays are always closed.
          </p>
        </div>
        {!formOpen && (
          <button
            type="button"
            className="docmgmt-primary"
            disabled={!data}
            onClick={() => setFormOpen(true)}
          >
            + Add holiday
          </button>
        )}
      </div>

      {bookedNotice && (
        <p className="docmgmt-leavebanner" role="status">
          {bookedNotice}
        </p>
      )}

      {formOpen && (
        <form
          className="docmgmt-timeoff-form"
          aria-label="Add clinic holiday"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            review();
          }}
        >
          <div className="docmgmt-form wrap">
            <Field id="holiday-title" label="Holiday name" error={errors.title}>
              <input
                id="holiday-title"
                value={form.title}
                maxLength={60}
                placeholder="Diwali"
                required
                onChange={set("title")}
                {...invalid("title")}
              />
            </Field>
            <Field id="holiday-from" label="First day" error={errors.from}>
              <input
                id="holiday-from"
                type="date"
                min={data?.limits.from}
                max={data?.limits.to}
                value={form.from}
                required
                onChange={set("from")}
                {...invalid("from")}
              />
            </Field>
            <Field id="holiday-to" label="Last day" error={errors.to}>
              <input
                id="holiday-to"
                type="date"
                min={form.from || data?.limits.from}
                max={data?.limits.to}
                value={form.to}
                onChange={set("to")}
                {...invalid("to")}
              />
            </Field>
          </div>
          {count && (
            <p className="docmgmt-hint" role="status">
              {plural(count.working, "holiday")}
              {count.sundays ? ` · ${plural(count.sundays, "Sunday")} skipped` : ""}
            </p>
          )}
          <div className="docmgmt-form-actions">
            <button type="button" className="docmgmt-secondary" onClick={closeForm}>
              Cancel
            </button>
            <button type="submit" className="docmgmt-primary">
              Add holiday
            </button>
          </div>
        </form>
      )}

      <div className="docmgmt-filter docmgmt-viewfilter" role="group" aria-label="Show holidays">
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
            {label} <span className="docmgmt-count">{grouped[id].length}</span>
          </button>
        ))}
      </div>

      <table className="docmgmt-list">
        <thead>
          <tr>
            <th>Date</th>
            <th>Holiday</th>
            <th>Booked</th>
            <th>Added by</th>
            <th>
              <span className="docmgmt-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                Loading…
              </td>
            </tr>
          )}
          {isError && (
            <tr>
              <td colSpan="5" className="docmgmt-empty" role="alert">
                Could not load clinic holidays.{" "}
                <button
                  type="button"
                  className="docmgmt-secondary docmgmt-small"
                  onClick={() => refetch()}
                >
                  Try again
                </button>
              </td>
            </tr>
          )}
          {data && rows.length === 0 && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                {view === "upcoming"
                  ? "No upcoming clinic holidays. Use “Add holiday” to close the clinic for a day, like Diwali."
                  : "No past clinic holidays."}
              </td>
            </tr>
          )}
          {rows.map((h) => (
            <tr key={h.id}>
              <td>{dayLabel(h.day)}</td>
              <td>{h.title}</td>
              <td>{h.booked ? plural(h.booked, "patient") : "—"}</td>
              <td>{h.added_by || "—"}</td>
              <td className="docmgmt-cell-action">
                {view === "upcoming" && (
                  <button
                    type="button"
                    className="docmgmt-del"
                    onClick={() => {
                      setActionError(null);
                      setRemoving(h);
                    }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmModal
        open={confirmAdd}
        variant="primary"
        title={`Close the clinic for ${form.title.trim()}?`}
        confirmLabel={busy ? "Adding…" : "Add holiday"}
        cancelLabel="Go back"
        busy={busy}
        error={actionError}
        onCancel={() => setConfirmAdd(false)}
        onConfirm={add}
        message={
          form.from && (
            <>
              <p>
                {rangeLabel(form.from, to)}
                {count ? ` · ${plural(count.working, "day")}` : ""}
                {count?.sundays ? ` (${plural(count.sundays, "Sunday")} skipped)` : ""}
              </p>
              <p>
                No new appointments can be booked on these days, for any doctor. Patients already
                booked are not moved automatically.
              </p>
            </>
          )
        }
      />

      <ConfirmModal
        open={Boolean(removing)}
        title={removing ? `Remove ${removing.title} on ${dayLabel(removing.day)}?` : ""}
        confirmLabel={busy ? "Removing…" : "Remove holiday"}
        cancelLabel="Go back"
        busy={busy}
        error={actionError}
        onCancel={() => setRemoving(null)}
        onConfirm={remove}
        message="The clinic opens again that day: booking is allowed, and it counts as a normal day for follow-up fees and CRM working days."
      />
    </div>
  );
}
