import { useEffect, useId, useMemo, useState } from "react";
import SearchBox from "../ui/SearchBox";
import Dropdown from "../ui/Dropdown";
import TimePicker from "../ui/TimePicker";
import DatePicker from "../DatePicker";
import Shimmer from "../Shimmer";
import { errorOf } from "../billing/format";
import { toast } from "../../stores/uiStore";
import useDebounced from "../../hooks/useDebounced";
import { useSetToken, useTokenQueue } from "../../queries/hooks/useGiniflowTokens";
import { istClock } from "../../../shared/homeCollection.js";
import { TOKEN_MAX, TOKEN_MIN } from "../../../shared/giniflowTokens.js";
import "./tokenQueue.css";

const EMPTY_FILTERS = { doctorId: "", from: "", to: "", q: "" };

const parseToken = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return { token: null };
  if (!/^\d+$/.test(trimmed)) return { error: "Enter the token as a whole number." };
  const token = Number(trimmed);
  if (token < TOKEN_MIN || token > TOKEN_MAX)
    return { error: `Enter a token from ${TOKEN_MIN} to ${TOKEN_MAX}.` };
  return { token };
};

function TokenInput({ row }) {
  const errorId = useId();
  const saved = row.token == null ? "" : String(row.token);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState(null);
  const setToken = useSetToken();

  useEffect(() => {
    if (!setToken.isPending) setDraft(saved);
  }, [saved, setToken.isPending]);

  const save = (text) => {
    const parsed = parseToken(text);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.token === row.token) {
      setDraft(saved);
      return;
    }
    setToken.mutate(
      { visitId: row.visitId, token: parsed.token },
      {
        onSuccess: () =>
          toast(
            parsed.token == null
              ? `Token cleared for ${row.name}`
              : `Token ${parsed.token} set for ${row.name}`,
          ),
        onError: (e) => {
          setDraft(saved);
          setError(errorOf(e, "The token was not saved. Try again."));
        },
      },
    );
  };

  return (
    <div className="tq-token">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="tq-token__input"
        aria-label={`Token for ${row.name}, ${row.fileNo || "no UHID"}`}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={draft}
        disabled={setToken.isPending}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save(e.currentTarget.value);
          }
          if (e.key === "Escape") {
            setDraft(saved);
            setError(null);
          }
        }}
        placeholder="—"
      />
      {row.token != null && (
        <button
          type="button"
          className="tq-token__clear"
          disabled={setToken.isPending}
          onClick={() => save("")}
          aria-label={`Clear token for ${row.name}`}
        >
          Clear
        </button>
      )}
      {setToken.isPending && <span className="tq-token__note">Saving…</span>}
      {error && (
        <span id={errorId} className="tq-token__error" role="alert">
          {error}
        </span>
      )}
      {!error && !setToken.isPending && row.tokenShared && (
        <span className="tq-token__note">Same token — first come first</span>
      )}
    </div>
  );
}

function TokenRow({ row, compact }) {
  return (
    <tr className={row.token == null ? "tq-row tq-row--none" : "tq-row"}>
      <td className="tq-num">{row.position ?? "—"}</td>
      <td>
        <TokenInput row={row} />
      </td>
      <th scope="row" className="tq-patient">
        <span className="tq-patient__name" title={row.name}>
          {row.name}
        </span>
        <span className="tq-patient__meta">
          {[row.fileNo, [row.age, row.sex?.[0]].filter(Boolean).join("")]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </th>
      <td>
        <span className="tq-doctor" title={row.doctorName}>
          {row.doctorName}
        </span>
      </td>
      <td className="tq-num">{row.appointmentTime || "—"}</td>
      <td className="tq-num">{row.arrivedAt ? istClock(row.arrivedAt) : "Not arrived"}</td>
      <td>
        <span className={`tq-status tq-status--${row.stage || "other"}`}>{row.statusLabel}</span>
      </td>
      {!compact && (
        <td className="tq-setby">
          {row.tokenSetBy ? `${row.tokenSetBy} · ${istClock(row.tokenSetAt)}` : "—"}
        </td>
      )}
    </tr>
  );
}

function EmptyState({ hasConsultants, filtered, onClear }) {
  if (!hasConsultants)
    return (
      <div className="tq-empty">
        <p className="tq-empty__title">No consultant uses the token queue yet</p>
        <p className="tq-empty__hint">
          An administrator turns it on per consultant in Doctor Management → “Token queue at Chief
          Endocrinologist”.
        </p>
      </div>
    );
  return (
    <div className="tq-empty">
      <p className="tq-empty__title">No patients found</p>
      <p className="tq-empty__hint">
        {filtered
          ? "No patients match the current filters."
          : "No patients of token-queue consultants are booked for this day yet."}
      </p>
      {filtered && (
        <button type="button" className="tq-btn" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

export default function TokenQueue({ date: fixedDate, compact = false }) {
  const [pickedDate, setPickedDate] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const q = useDebounced(filters.q, 300);
  const date = fixedDate ?? pickedDate;
  const { data, isLoading, isError, refetch, isFetching } = useTokenQueue({
    date,
    doctorId: filters.doctorId,
    from: filters.from,
    to: filters.to,
    q,
  });

  const set = (key) => (value) => setFilters((f) => ({ ...f, [key]: value ?? "" }));
  const filtered = Object.keys(EMPTY_FILTERS).some((k) => filters[k] !== EMPTY_FILTERS[k]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const tokened = rows.filter((r) => r.token != null).length;

  const consultantOptions = [
    { value: "", label: "All consultants" },
    ...(data?.consultants ?? []).map((d) => ({ value: String(d.id), label: d.shortName })),
  ];

  return (
    <section
      className={compact ? "tq tq--compact" : "tq"}
      aria-label="Chief Endocrinologist tokens"
    >
      <div className="tq-filters" role="search">
        <SearchBox
          value={filters.q}
          onChange={set("q")}
          placeholder="Search by patient name, UHID or phone"
          label="Search patients"
        />
        <Dropdown
          value={filters.doctorId}
          options={consultantOptions}
          onChange={set("doctorId")}
          ariaLabel="Consultant"
        />
        <TimePicker
          value={filters.from}
          onChange={set("from")}
          ariaLabel="Appointment from"
          placeholder="From any time"
        />
        <TimePicker
          value={filters.to}
          onChange={set("to")}
          ariaLabel="Appointment until"
          placeholder="Until any time"
        />
        {fixedDate === undefined && (
          <DatePicker
            value={pickedDate}
            onChange={(d) => setPickedDate(d || "")}
            placeholder="Today"
            ariaLabel="Day"
          />
        )}
        {filtered && (
          <button
            type="button"
            className="tq-btn tq-btn--quiet"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className="tq-summary" aria-live="polite">
        {isLoading
          ? "Loading patients…"
          : `${rows.length} patient${rows.length === 1 ? "" : "s"} · ${tokened} with a token`}
        {isFetching && !isLoading ? " · updating…" : ""}
        <span className="tq-summary__rule">
          Lowest token sees the Chief Endocrinologist first; the same token goes by arrival.
          Patients without a token follow.
        </span>
      </p>

      {isLoading ? (
        <Shimmer type="lines" count={6} />
      ) : isError && !data ? (
        <div className="tq-empty" role="alert">
          <p className="tq-empty__title">Unable to load the token list</p>
          <p className="tq-empty__hint">
            Please try again. If the problem continues, contact an administrator.
          </p>
          <button type="button" className="tq-btn" onClick={() => refetch()}>
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          hasConsultants={(data?.consultants ?? []).length > 0}
          filtered={filtered}
          onClear={() => setFilters(EMPTY_FILTERS)}
        />
      ) : (
        <div className="tq-tablewrap">
          <table className="tq-table">
            <thead>
              <tr>
                <th scope="col" className="tq-num">
                  Order
                </th>
                <th scope="col">Token</th>
                <th scope="col">Patient</th>
                <th scope="col">Consultant</th>
                <th scope="col" className="tq-num">
                  Appointment
                </th>
                <th scope="col" className="tq-num">
                  Arrived
                </th>
                <th scope="col">Status</th>
                {!compact && <th scope="col">Token set by</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TokenRow key={row.visitId} row={row} compact={compact} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
