import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useTriageDay,
  useTriageStaff,
  useSetCategory,
  useAssignVisit,
  useRerunTriage,
} from "../../queries/hooks/useGiniflowTriage";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import usePatientStore from "../../stores/patientStore.js";
import LiveBadge from "../../components/giniflow/LiveBadge";
import PipelineBar from "./triage/PipelineBar";
import TriageColumn from "./triage/TriageColumn";
import AssignMenu from "./triage/AssignMenu";
import UploadDialog from "./triage/UploadDialog";
import "../../styles/giniflow-triage.css";

// The coordinator's pre-OPD board — docs/gini-flow/18-TRIAGE-BOARD-PLAN.md.
//
// Every other Gini Flow screen works the patient who is in the building. This
// one works the day BEFORE they arrive, which is why it opens on tomorrow: are
// the reports in, what do the numbers say, who should see them, and who is
// going to be a problem at 9am.
//
// It is also the only writer of `giniflow_visits.category`, the column the
// board's dot, the consultant's chip and the MO's "can I close this patient
// without the doctor" rule all read.

const istDay = (offsetDays = 0) =>
  new Date(Date.now() + 5.5 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

const shiftDay = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const longDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export default function TriageBoardPage() {
  const navigate = useNavigate();
  const { loadPatientDB } = usePatientStore();

  // Tomorrow, not today: the screen's whole purpose is the day before the day.
  const [date, setDate] = useState(() => istDay(1));
  const [filter, setFilter] = useState(null);
  const [doctorId, setDoctorId] = useState(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [assigning, setAssigning] = useState(null);
  const [uploading, setUploading] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const live = useGiniflowLive({ date, paused: !!assigning || !!uploading });
  const { data, isLoading, isError, isFetching, refetch } = useTriageDay(date, {
    filter,
    doctorId,
    q: debounced,
  });
  const { data: staffData } = useTriageStaff(date);
  const setCategory = useSetCategory();
  const assignVisit = useAssignVisit();
  const rerun = useRerunTriage();

  const staff = staffData?.staff || [];
  const columns = data?.columns || [];
  const allCards = useMemo(
    () => [...columns.flatMap((c) => c.cards), ...(data?.uncategorised || [])],
    [columns, data],
  );

  // Kept in sync with whatever the server just returned, so the open dialog
  // shows the assignment a poll landed rather than the one it opened with.
  const openCard = assigning ? allCards.find((c) => c.visitId === assigning) || null : null;

  const saving = setCategory.isPending || assignVisit.isPending;

  const onSave = async ({ category, sdId, doctorId: docId }) => {
    const card = openCard;
    if (!card) return;
    try {
      if (category !== card.category) {
        await setCategory.mutateAsync({ visitId: card.visitId, category });
      }
      if (sdId !== card.assignment.sdId || docId !== card.assignment.doctorId) {
        await assignVisit.mutateAsync({
          visitId: card.visitId,
          assignedSdId: sdId ?? null,
          assignedDoctorId: docId ?? null,
        });
      }
      setAssigning(null);
      setToast(`${card.name} updated`);
    } catch (e) {
      setToast(e.response?.data?.error || "Could not save that");
    }
  };

  const onReset = async () => {
    if (!openCard) return;
    try {
      const r = await setCategory.mutateAsync({ visitId: openCard.visitId, category: null });
      setAssigning(null);
      setToast(`${openCard.name} handed back to the engine — now ${r.category || "uncategorised"}`);
    } catch (e) {
      setToast(e.response?.data?.error || "Could not reset that");
    }
  };

  const openPatient = (card) => {
    loadPatientDB({
      id: card.patientId,
      name: card.name,
      file_no: card.fileNo,
      age: card.age,
      sex: card.sex,
    });
    navigate("/dashboard");
  };

  const rerunEngine = async () => {
    try {
      const r = await rerun.mutateAsync(date);
      setToast(
        r.updated
          ? `${r.updated} of ${r.considered} re-categorised`
          : "Nothing changed — every patient is already in the right column",
      );
    } catch {
      setToast("Could not re-run the engine");
    }
  };

  if (isLoading && !data) return <div className="gf gf-loading">Building the day…</div>;
  if (isError && !data)
    return <div className="gf gf-loading">Triage board unavailable — retrying…</div>;

  const totals = data?.totals || {};
  const steps = data?.steps || [];
  const uncategorised = data?.uncategorised || [];
  const isToday = date === istDay(0);
  const isTomorrow = date === istDay(1);
  const dayName = isToday ? "Today's" : isTomorrow ? "Tomorrow's" : `${longDate(date)}`;
  const filtering = !!filter || !!doctorId || debounced.trim().length >= 2;

  // Only a transient state — the sweep gives everyone a category, `no_reports`
  // included — but a patient the engine could not place must never silently
  // vanish from the day.
  const shownColumns = uncategorised.length
    ? [
        ...columns,
        {
          key: "uncategorised",
          icon: "⏳",
          short: "Not categorised yet",
          label: "Not categorised yet",
          lead: "Waiting for the engine — or for you",
          tone: "none",
          count: uncategorised.length,
          cards: uncategorised,
        },
      ]
    : columns;

  return (
    <div className="gf gf-triage">
      <div className="rail">
        <div className="rl">Gini Flow</div>
        <div className="rsep" />
        <span className="rail-title">Triage</span>
        <LiveBadge live={live} />
        <span className="rail-date-label">{longDate(date)}</span>
        <div className="rr">
          <a className="rbtn" href="/giniflow/stations">
            Stations
          </a>
          <a className="rbtn" href="/giniflow/manager">
            Floor board
          </a>
        </div>
      </div>

      <div className="tri-main">
        <div className="tri-head">
          <div>
            <div className="th-title">{dayName} patient triage</div>
            <div className="th-meta">
              {longDate(date)} · {totals.total ?? 0} patient
              {totals.total === 1 ? "" : "s"} · {totals.uncategorised ?? 0} to categorise ·{" "}
              {totals.unassigned ?? 0} unassigned
              {totals.coordinatorSet ? ` · ${totals.coordinatorSet} set by hand` : ""}
            </div>
          </div>
          <div className="th-actions">
            <div className="th-date">
              <button
                type="button"
                className="dnav"
                aria-label="Previous day"
                onClick={() => setDate(shiftDay(date, -1))}
              >
                ‹
              </button>
              <input
                className="tri-input"
                type="date"
                value={date}
                aria-label="Triage date"
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
              <button
                type="button"
                className="dnav"
                aria-label="Next day"
                onClick={() => setDate(shiftDay(date, 1))}
              >
                ›
              </button>
              <button type="button" className="tbtn" onClick={() => setDate(istDay(1))}>
                Tomorrow
              </button>
            </div>
            <input
              className="tri-input tri-search"
              type="search"
              value={search}
              placeholder="Search name or file no…"
              aria-label="Search this day's patients"
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="button" className="tbtn" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "⟳ Refreshing…" : "⟳ Refresh"}
            </button>
            <button
              type="button"
              className="tbtn"
              onClick={rerunEngine}
              disabled={rerun.isPending}
              title="Re-read every patient's HbA1c and re-sort the columns. Patients you set by hand are left alone."
            >
              {rerun.isPending ? "Re-running…" : "⚙ Re-run engine"}
            </button>
            <button
              type="button"
              className="tbtn pu"
              onClick={() => setUploading({ global: true })}
            >
              📤 Upload reports
            </button>
          </div>
        </div>

        <PipelineBar
          steps={steps}
          active={filter}
          onSelect={setFilter}
          total={data?.pipeline?.total ?? 0}
        />

        <div className="tri-filters">
          <span className="flbl">Assigned to</span>
          <button
            type="button"
            className={`fchip${doctorId === null ? " active" : ""}`}
            onClick={() => setDoctorId(null)}
          >
            Everyone
          </button>
          {staff
            .filter((p) => p.assignedToday > 0 || p.isChief)
            .map((person) => (
              <button
                type="button"
                key={person.id}
                className={`fchip${doctorId === person.id ? " active" : ""}${
                  person.assignedToday ? "" : " count-0"
                }`}
                onClick={() => setDoctorId(doctorId === person.id ? null : person.id)}
                title="Shows only this clinician's list — it never changes an assignment"
              >
                {person.shortName} · {person.assignedToday}
              </button>
            ))}
          {filtering && (
            <>
              <span className="fsep" />
              <span className="flbl">
                Showing {totals.shown ?? 0} of {totals.total ?? 0}
              </span>
              <button
                type="button"
                className="fchip"
                onClick={() => {
                  setFilter(null);
                  setDoctorId(null);
                  setSearch("");
                }}
              >
                ✕ Clear
              </button>
            </>
          )}
        </div>

        <div className="tri-board">
          {shownColumns.map((column) => (
            <TriageColumn
              key={column.key}
              column={column}
              busyId={saving ? assigning : null}
              onAssign={(card) => setAssigning(card.visitId)}
              onUpload={(card) => setUploading({ card })}
              onOpen={openPatient}
            />
          ))}
        </div>
      </div>

      {openCard && (
        <AssignMenu
          card={openCard}
          staff={staff}
          saving={saving}
          onClose={() => setAssigning(null)}
          onSave={onSave}
          onReset={onReset}
        />
      )}
      {uploading && (
        <UploadDialog
          card={uploading.card || null}
          cards={allCards}
          onClose={() => setUploading(null)}
          onSaved={(name) => {
            setUploading(null);
            setToast(`Report saved for ${name} — re-run the engine to re-sort them`);
            refetch();
          }}
        />
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
