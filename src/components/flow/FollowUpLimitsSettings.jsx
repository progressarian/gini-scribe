import { useEffect, useState } from "react";
import { toast } from "../../stores/uiStore";
import { useFollowUpLimits, useSaveFollowUpLimits } from "../../queries/hooks/useFollowUpLoad";

const MAX_LIMIT = 10000;
const textOf = (n) => (n == null ? "" : String(n));

function parseLimit(text, label) {
  const trimmed = text.trim();
  if (!trimmed) return { value: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { error: `${label} must be a whole number from 1 to ${MAX_LIMIT}, or left empty.` };
  }
  return { value: n };
}

export default function FollowUpLimitsSettings() {
  const { data: limits, isLoading, isError, refetch } = useFollowUpLimits();
  const save = useSaveFollowUpLimits();
  const [form, setForm] = useState({ allowed: "", max: "" });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (limits) setForm({ allowed: textOf(limits.allowedPerDay), max: textOf(limits.maxPerDay) });
  }, [limits]);

  const dirty =
    !!limits &&
    (form.allowed.trim() !== textOf(limits.allowedPerDay) ||
      form.max.trim() !== textOf(limits.maxPerDay));

  const submit = (e) => {
    e.preventDefault();
    const allowed = parseLimit(form.allowed, "Allowed per day");
    const max = parseLimit(form.max, "Max per day");
    const next = { allowed: allowed.error, max: max.error };
    if (!next.allowed && !next.max && allowed.value && max.value && allowed.value > max.value) {
      next.allowed = "Allowed per day can't be more than Max per day.";
    }
    setErrors(next);
    if (next.allowed || next.max) return;
    save.mutate(
      { allowedPerDay: allowed.value, maxPerDay: max.value },
      {
        onSuccess: () => toast("Follow-up limits saved", "success"),
        onError: (err) => toast(err?.response?.data?.error || "Could not save the limits", "error"),
      },
    );
  };

  return (
    <section className="flow-card fset__section" aria-labelledby="fset-follow-up-title">
      <div className="fset__cardhead">
        <h2 className="flow-sec-title" id="fset-follow-up-title">
          Follow-ups per day
        </h2>
      </div>
      <p className="fset__cardsub">
        How many follow-up visits doctors can book on one date, across the whole hospital. Above the
        allowed number the doctor sees a warning but can still book. At the maximum the date is
        closed for new follow-ups. Leave a box empty for no limit.
      </p>
      {isError ? (
        <p className="fset__hint" role="alert">
          Unable to load the follow-up limits.{" "}
          <button type="button" className="flow-btn" onClick={() => refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <form className="fset__machine-grid fset__limits" onSubmit={submit} noValidate>
          <div className="fset__field fset__field--limit">
            <label htmlFor="fset-follow-up-allowed">Allowed per day</label>
            <input
              id="fset-follow-up-allowed"
              className="jb-assign"
              type="number"
              inputMode="numeric"
              min="1"
              max={MAX_LIMIT}
              placeholder="No limit"
              disabled={isLoading || save.isPending}
              value={form.allowed}
              aria-invalid={!!errors.allowed}
              aria-describedby={errors.allowed ? "fset-follow-up-allowed-error" : undefined}
              onChange={(e) => setForm((f) => ({ ...f, allowed: e.target.value }))}
            />
            {errors.allowed && (
              <small className="fset__error" id="fset-follow-up-allowed-error">
                {errors.allowed}
              </small>
            )}
          </div>
          <div className="fset__field fset__field--limit">
            <label htmlFor="fset-follow-up-max">Max per day</label>
            <input
              id="fset-follow-up-max"
              className="jb-assign"
              type="number"
              inputMode="numeric"
              min="1"
              max={MAX_LIMIT}
              placeholder="No limit"
              disabled={isLoading || save.isPending}
              value={form.max}
              aria-invalid={!!errors.max}
              aria-describedby={errors.max ? "fset-follow-up-max-error" : undefined}
              onChange={(e) => setForm((f) => ({ ...f, max: e.target.value }))}
            />
            {errors.max && (
              <small className="fset__error" id="fset-follow-up-max-error">
                {errors.max}
              </small>
            )}
          </div>
          <div className="fset__limits-actions">
            <button
              className="flow-btn flow-btn-primary"
              type="submit"
              disabled={isLoading || save.isPending || !dirty}
            >
              {save.isPending ? "Saving…" : "Save limits"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
