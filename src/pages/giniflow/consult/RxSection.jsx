import { useEffect, useState } from "react";
import {
  usePrescription,
  useSeedDraft,
  useAddItem,
  useUpdateItem,
  useRemoveItem,
  usePauseItem,
  useStopItem,
  useMedicineSearch,
  useAlternatives,
} from "../../../queries/hooks/useGiniflowPrescription";
import { VoiceBar, VoiceButton } from "../../../components/giniflow/VoiceInput";

// Prescription — gini-doctor-final.html `s-rx` (which is where
// gini-prescription-v2.html's mechanics were merged).
//
// Nothing here reaches the patient's chart until Finalize: every edit lands in
// the draft. A consultation interrupted by a phone call loses nothing.

export const TIMINGS = [
  ["before_breakfast", "Before breakfast"],
  ["with_breakfast", "With breakfast"],
  ["after_breakfast", "After breakfast"],
  ["before_lunch", "Before lunch"],
  ["with_lunch", "With lunch"],
  ["after_lunch", "After lunch"],
  ["evening", "Evening"],
  ["before_dinner", "Before dinner"],
  ["with_dinner", "With dinner"],
  ["after_dinner", "After dinner"],
  ["bedtime", "At bedtime"],
  ["with_meals", "With meals"],
  ["sos", "As needed (SOS)"],
  ["weekly", "Weekly"],
  ["fortnightly", "Fortnightly"],
];

const FREQUENCIES = ["OD", "BD", "TDS", "QID", "SOS", "Weekly", "Fortnightly"];
const TIMING_LABEL = Object.fromEntries(TIMINGS);

// gini-doctor-final.html s-rx, verbatim. Voice dictates into the search box
// today; the parser that would act on these is §4b step 3.
const RX_VOICE_EXAMPLES = [
  "Increase Atchol to 40mg",
  "Add Fenofibrate 145mg once daily with lunch",
  "Stop Montair",
  "Pause Lipaglyn 2 weeks",
];

const CHANGE_CHIP = {
  new: { cls: "ch-new", label: "🆕 Added this visit" },
  changed: { cls: "ch-changed", label: "↑ Changed" },
  paused: { cls: "ch-paused", label: "⏸ Paused" },
  stopped: { cls: "ch-stopped", label: "✕ Stopped" },
};

// Stock is shown only where it is known. A medicine with no inventory row reads
// "Stock —", never "in stock": a false in-stock sends a patient to a counter
// that cannot serve them (plan §7).
function StockCell({ stock, onAlternatives }) {
  if (!stock) return <span className="rx-stock rx-unknown">Stock —</span>;
  if (stock.out) {
    return (
      <span className="rx-stock rx-out">
        ✗ Out of stock
        <button type="button" className="btn-sm" onClick={onAlternatives}>
          Alternatives →
        </button>
      </span>
    );
  }
  return (
    <span className={`rx-stock ${stock.low ? "rx-low" : "rx-ok"}`}>
      {stock.low ? "⚠" : "✓"} {stock.qty} left
    </span>
  );
}

function AlternativesPanel({ name, onClose, onPick }) {
  const { data, isLoading } = useAlternatives(name);
  return (
    <div className="rx-alts">
      <div className="cn-head">Alternatives for {name}</div>
      {isLoading && <div className="cn-empty">Checking stock…</div>}
      {!isLoading && !data?.known && (
        <div className="cn-empty">
          The pharmacy list has no record of this medicine, so its substitutes are unknown. Check
          with the counter before changing it.
        </div>
      )}
      {!isLoading && data?.known && data.alternatives.length === 0 && (
        <div className="cn-empty">Nothing of the same class is in stock.</div>
      )}
      {(data?.alternatives || []).map((a) => (
        <button type="button" key={a.name} className="rx-alt" onClick={() => onPick(a)}>
          ✓ {a.name} <em>{a.qty} in stock</em>
        </button>
      ))}
      <button type="button" className="btn-sm" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function RowEditor({ item, onSave, onCancel, onPause, onStop }) {
  const [form, setForm] = useState({
    dose: item.dose || "",
    frequency: item.frequency || "",
    timingCategory: item.timing_category || "",
    timeOfDay: (item.time_of_day || "").slice(0, 5),
    duration: item.duration || "",
    reason: item.reason || "",
    patientInstruction: item.patient_instruction || "",
    route: item.route || "Oral",
  });
  const [stopping, setStopping] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const set = (f) => (e) => setForm((p) => ({ ...p, [f]: e.target.value }));

  return (
    <div className="rx-edit">
      <div className="rx-grid">
        <label>
          Dose
          <input className="cp-inp" value={form.dose} onChange={set("dose")} />
        </label>
        <label>
          Frequency
          <select className="cp-inp" value={form.frequency} onChange={set("frequency")}>
            <option value="">—</option>
            {FREQUENCIES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Timing
          <select className="cp-inp" value={form.timingCategory} onChange={set("timingCategory")}>
            <option value="">—</option>
            {TIMINGS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Time
          <input
            className="cp-inp"
            type="time"
            value={form.timeOfDay}
            onChange={set("timeOfDay")}
          />
        </label>
        <label>
          Route
          <select className="cp-inp" value={form.route} onChange={set("route")}>
            {["Oral", "SC", "IM", "IV", "Topical", "Inhaled"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Duration
          <input className="cp-inp" value={form.duration} onChange={set("duration")} />
        </label>
      </div>
      <label className="rx-wide">
        Reason / for
        <input className="cp-inp" value={form.reason} onChange={set("reason")} />
      </label>
      <label className="rx-wide">
        Patient instruction
        <input
          className="cp-inp"
          value={form.patientInstruction}
          onChange={set("patientInstruction")}
        />
      </label>

      {stopping ? (
        <div className="rx-stop">
          {/* A stop carries its reason: the pharmacy and the patient both see
              this medicine disappear, and both deserve to know why. */}
          <input
            className="cp-inp"
            autoFocus
            placeholder="Why is this being stopped?"
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
          />
          <button
            type="button"
            className="btn-sm on"
            disabled={!stopReason.trim()}
            onClick={() => onStop(stopReason.trim())}
          >
            Stop it
          </button>
          <button type="button" className="btn-sm" onClick={() => setStopping(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="rx-acts">
          <button
            type="button"
            className="btn-sm on"
            onClick={() =>
              onSave({
                ...form,
                timeOfDay: form.timeOfDay || null,
                timingCategory: form.timingCategory || null,
              })
            }
          >
            Save
          </button>
          <button type="button" className="btn-sm" onClick={onCancel}>
            Cancel
          </button>
          {/* Pause and stop are different clinical acts: a pause keeps the
              medicine and a resume date, a stop ends it. */}
          <button type="button" className="btn-sm ep-pause" onClick={() => onPause(2)}>
            Pause 2 weeks
          </button>
          <button type="button" className="btn-sm ep-stop" onClick={() => setStopping(true)}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

function AddMedicine({ onAdd, onClose, initialQuery = "" }) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState(null);
  const [form, setForm] = useState({ dose: "", frequency: "OD", timingCategory: "", reason: "" });
  const { data, isFetching } = useMedicineSearch(debounced);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <div className="rx-add">
      <div className="cn-head">Add a medicine</div>
      <div className="rx-search-row">
        <input
          className="cp-inp"
          autoFocus
          placeholder="Search — brand or molecule"
          value={picked ? picked.name : query}
          onChange={(e) => {
            setPicked(null);
            setQuery(e.target.value);
          }}
        />
        {/* The prototype's icon-only mic: "Say the medicine name and dose". */}
        <VoiceButton
          title="Say the medicine name and dose"
          onText={(text) => {
            setPicked(null);
            setQuery(text);
          }}
        />
      </div>
      {!picked && debounced.length >= 2 && (
        <div className="rx-results">
          {isFetching && <div className="cn-empty">Searching…</div>}
          {(data?.results || []).map((r) => (
            <button type="button" key={r.name} className="rx-result" onClick={() => setPicked(r)}>
              <strong>{r.name}</strong>
              <em>
                {r.composition || r.drugClass || "—"}
                {r.timesPrescribed ? ` · prescribed ${r.timesPrescribed}×` : ""}
              </em>
              {r.stock ? (
                <span className={r.stock.out ? "rx-out" : "rx-ok"}>
                  {r.stock.out ? "✗ out" : `✓ ${r.stock.qty}`}
                </span>
              ) : (
                <span className="rx-unknown">stock —</span>
              )}
            </button>
          ))}
          {!isFetching && (data?.results || []).length === 0 && (
            <div className="cn-empty">Nothing matched.</div>
          )}
        </div>
      )}

      {picked && (
        <>
          <div className="rx-grid">
            <label>
              Dose
              <input
                className="cp-inp"
                autoFocus
                value={form.dose}
                onChange={(e) => setForm((p) => ({ ...p, dose: e.target.value }))}
              />
            </label>
            <label>
              Frequency
              <select
                className="cp-inp"
                value={form.frequency}
                onChange={(e) => setForm((p) => ({ ...p, frequency: e.target.value }))}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              Timing
              <select
                className="cp-inp"
                value={form.timingCategory}
                onChange={(e) => setForm((p) => ({ ...p, timingCategory: e.target.value }))}
              >
                <option value="">—</option>
                {TIMINGS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="rx-wide">
            Reason / for
            <input
              className="cp-inp"
              value={form.reason}
              onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
            />
          </label>
          <div className="rx-acts">
            <button
              type="button"
              className="btn-sm on"
              onClick={() =>
                onAdd({
                  medicineName: picked.name,
                  composition: picked.composition,
                  drugClass: picked.drugClass,
                  changeType: "new",
                  ...form,
                  timingCategory: form.timingCategory || null,
                })
              }
            >
              + Add to prescription
            </button>
            <button type="button" className="btn-sm" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {!picked && (
        <button type="button" className="btn-sm" onClick={onClose}>
          Cancel
        </button>
      )}
    </div>
  );
}

export default function RxSection({ visitId, readOnly, onToast }) {
  const { data, isLoading } = usePrescription(visitId);
  const seed = useSeedDraft(visitId);
  const add = useAddItem(visitId);
  const update = useUpdateItem(visitId);
  const remove = useRemoveItem(visitId);
  const pause = usePauseItem(visitId);
  const stop = useStopItem(visitId);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [alternativesFor, setAlternativesFor] = useState(null);
  const [spoken, setSpoken] = useState("");

  const fail = (e) => onToast(e?.response?.data?.error || "That change was not saved");

  if (isLoading) return <section className="csec">Loading the prescription…</section>;
  const items = data?.items || [];

  return (
    <section className="csec" id="s-rx">
      <div className="cs-head">
        <h2>💊 Prescription</h2>
        <span className="cs-sub">
          {items.length} medicine{items.length === 1 ? "" : "s"} · nothing is dispensed until you
          finalize
        </span>
        <div className="cs-head-r">
          {data?.lastUpdated && (
            <span className="badge b-ink">Last updated: {data.lastUpdated}</span>
          )}
          {(data?.stopped || []).length > 0 && (
            <button
              type="button"
              className="btn-sm"
              onClick={() =>
                onToast(
                  `Stopped: ${data.stopped
                    .map((m) => `${m.medicine_name}${m.stopped_on ? ` (${m.stopped_on})` : ""}`)
                    .join(" · ")}`,
                )
              }
            >
              Stopped meds
            </button>
          )}
          {!readOnly && (
            <VoiceButton
              small
              label="🎤 Voice edit"
              title={`Say: ${RX_VOICE_EXAMPLES.join(" · ")}`}
              onText={(text) => {
                setAdding(true);
                setSpoken(text);
              }}
            />
          )}
        </div>
      </div>

      {/* The teaching bar. Dictation fills the add-medicine search; it does not
          execute the phrase (§4b.3). */}
      {!readOnly && (
        <VoiceBar
          examples={RX_VOICE_EXAMPLES}
          onText={(text) => {
            setAdding(true);
            setSpoken(text);
          }}
        />
      )}

      {items.length === 0 && (
        <div className="rx-seed">
          <p className="cn-empty">
            The draft is empty.
            {data?.activeMedications?.length
              ? ` This patient is on ${data.activeMedications.length} medicine${
                  data.activeMedications.length === 1 ? "" : "s"
                } — start from those rather than retyping them.`
              : " This patient has no active medicines on record."}
          </p>
          {!readOnly && data?.activeMedications?.length > 0 && (
            <button
              type="button"
              className="btn-sm on"
              onClick={() => seed.mutate(undefined, { onError: fail })}
            >
              Start from current regimen
            </button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="rx-thead">
          <span className="rx-num">#</span>
          <span className="rx-main">Medicine</span>
          <span className="rx-col-dose">Dose</span>
          <span className="rx-col-timing">Timing</span>
          <span className="rx-col-for">For</span>
          <span className="rx-col-stock">Pharmacy stock</span>
          <span className="rx-col-acts">Actions</span>
        </div>
      )}

      {items.map((item, i) => {
        const chip = CHANGE_CHIP[item.change_type];
        return (
          <div className="rx-item" key={item.id}>
            <div
              className={`rx-row${item.change_type === "stopped" ? " rx-gone" : ""}${
                item.change_type === "new" ? " rx-isnew" : ""
              }${item.change_type === "changed" ? " rx-ischanged" : ""}`}
            >
              <div className="rx-num">{i + 1}.</div>
              <div className="rx-main">
                <div className="rx-name">
                  {item.medicine_name}
                  {chip && <span className={`rx-chip ${chip.cls}`}>{chip.label}</span>}
                </div>
                {/* composition · why — the column a consultant scans. */}
                <div className="rx-sub">{item.composition || "—"}</div>
                {(item.previous_dose || item.stop_reason) && (
                  <div className="rx-meta">
                    {item.previous_dose ? `was ${item.previous_dose}` : ""}
                    {item.previous_dose && item.stop_reason ? " · " : ""}
                    {item.stop_reason || ""}
                  </div>
                )}
              </div>
              {/* Dose and timing are columns now, as the prototype has them: a
                consultant compares them down the list, not across a sentence. */}
              <div className="rx-col-dose">
                {[item.dose, item.frequency].filter(Boolean).join(" ") || "—"}
              </div>
              <div className="rx-col-timing">
                {TIMING_LABEL[item.timing_category] || "not set"}
                {item.time_of_day && <em>{item.time_of_day.slice(0, 5)}</em>}
              </div>
              <div className="rx-col-for">
                {item.reason ? <span className="rx-for">{item.reason}</span> : "—"}
              </div>
              <StockCell stock={item.stock} onAlternatives={() => setAlternativesFor(item.id)} />
              {!readOnly && (
                <div className="rx-rowacts">
                  <button
                    type="button"
                    className="ra-btn ra-edit"
                    onClick={() => setEditing(editing === item.id ? null : item.id)}
                  >
                    {editing === item.id ? "Close" : "Edit"}
                  </button>
                  {/* A medicine the consultant added by mistake is removed; one the
                    patient is actually taking is stopped, with a reason. */}
                  {item.change_type === "new" ? (
                    <button
                      type="button"
                      className="ra-btn ra-stop"
                      onClick={() => remove.mutate(item.id, { onError: fail })}
                    >
                      Remove
                    </button>
                  ) : (
                    item.change_type !== "stopped" && (
                      <button
                        type="button"
                        className="ra-btn ra-pause"
                        onClick={() =>
                          pause.mutate({ itemId: item.id, weeks: 2 }, { onError: fail })
                        }
                      >
                        Pause
                      </button>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Full width, beneath the row — a six-field form does not belong in
                one seventh of a table row. */}
            {editing === item.id && !readOnly && (
              <RowEditor
                item={item}
                onSave={(patch) => {
                  update.mutate({ itemId: item.id, ...patch }, { onError: fail });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                onPause={(weeks) => {
                  pause.mutate({ itemId: item.id, weeks }, { onError: fail });
                  setEditing(null);
                }}
                onStop={(reason) => {
                  stop.mutate({ itemId: item.id, reason }, { onError: fail });
                  setEditing(null);
                }}
              />
            )}
            {alternativesFor === item.id && (
              <AlternativesPanel
                name={item.pharmacy_match || item.medicine_name}
                onClose={() => setAlternativesFor(null)}
                onPick={(alt) => {
                  add.mutate(
                    {
                      medicineName: alt.name,
                      dose: item.dose,
                      frequency: item.frequency,
                      timingCategory: item.timing_category,
                      reason: item.reason,
                      changeType: "new",
                    },
                    { onError: fail },
                  );
                  stop.mutate(
                    { itemId: item.id, reason: `Out of stock — replaced by ${alt.name}` },
                    { onError: fail },
                  );
                  setAlternativesFor(null);
                }}
              />
            )}
          </div>
        );
      })}

      {!readOnly &&
        (adding ? (
          <AddMedicine
            initialQuery={spoken}
            onAdd={(item) => {
              add.mutate(item, { onError: fail, onSuccess: () => setAdding(false) });
            }}
            onClose={() => {
              setAdding(false);
              setSpoken("");
            }}
          />
        ) : (
          <button type="button" className="btn-sm on rx-addbtn" onClick={() => setAdding(true)}>
            + Add medicine
          </button>
        ))}

      {/* Other doctors' prescriptions: shown, never dispensed. */}
      <div className="cs-head">
        <h3>🏥 External medicines</h3>
        <span className="cs-sub">
          from other doctors · shown on the card, not dispensed by Gini
        </span>
      </div>
      {(data?.external || []).length === 0 && (
        <div className="cn-empty">None recorded for this patient.</div>
      )}
      {(data?.external || []).map((m) => (
        <div className="rx-ext" key={m.id}>
          <div className="rx-main">
            <div className="rx-name">{m.name}</div>
            <div className="rx-meta">
              {[m.dose, m.frequency, m.timing].filter(Boolean).join(" · ") || "—"} ·{" "}
              {m.external_doctor}
              {m.since_date ? ` · since ${m.since_date}` : ""}
            </div>
          </div>
          {/* An unchecked interaction must look unchecked. Rendering "no
              interaction" for a pair nobody has checked would be the most
              dangerous thing on this screen. */}
          <span className={`rx-inter${m.clinical_note ? " flagged" : ""}`}>
            {m.clinical_note ? `⚠ ${m.clinical_note}` : "interaction not checked"}
          </span>
        </div>
      ))}
    </section>
  );
}
