import { useState, useRef, useEffect, useCallback } from "react";
import api from "../services/api.js";
import { REFERRAL_ANSWER_TYPES } from "../../shared/crmVocab.js";

// "Who referred you?" — mandatory at registration, and the primary source of
// verified referral attribution (docs/CRM_PLAN.md).
//
// The front desk answers this during a queue, so the shape of the control is
// the whole design: the common answer must cost one tap. "Came on their own"
// and "A doctor" are both single taps, and only the doctor branch opens a
// search. Nothing here blocks on the network — the three choices render
// instantly and the search runs underneath.

const SELF = "none_self";
const DOCTOR = "doctor";
const OTHER = "free_text";

const label = (v) => REFERRAL_ANSWER_TYPES.find((a) => a.value === v)?.label || v;

export default function ReferralSourcePicker({ value, onChange, error, autoFocus = false }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const timer = useRef(null);

  const answer = value?.answer_type || null;
  const picked = value?.doctor || null;

  const search = useCallback((q) => {
    if (q.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    api
      .get("/api/crm/registration/referring-doctors", { params: { q, limit: 8 } })
      .then(({ data }) => setResults(Array.isArray(data) ? data : []))
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, []);

  useEffect(() => {
    if (answer !== DOCTOR) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(query), 220);
    return () => clearTimeout(timer.current);
  }, [query, answer, search]);

  useEffect(() => {
    const away = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const choose = (type) => {
    if (type === SELF) return onChange({ answer_type: SELF });
    if (type === DOCTOR) {
      onChange({ answer_type: DOCTOR, doctor_id: null, doctor: null });
      setOpen(true);
      return;
    }
    onChange({ answer_type: OTHER, free_text: "" });
  };

  const pickDoctor = (d) => {
    onChange({ answer_type: DOCTOR, doctor_id: d.doctor_id, doctor: d });
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  return (
    <div className={`refsrc ${error ? "refsrc--error" : ""}`} ref={boxRef}>
      <span className="refsrc__label">Who referred this patient? *</span>

      <div className="refsrc__choices" role="group" aria-label="Referral source">
        <button
          type="button"
          className={`refsrc__chip ${answer === SELF ? "refsrc__chip--on" : ""}`}
          onClick={() => choose(SELF)}
          autoFocus={autoFocus}
        >
          Came on their own
        </button>
        <button
          type="button"
          className={`refsrc__chip ${answer === DOCTOR ? "refsrc__chip--on" : ""}`}
          onClick={() => choose(DOCTOR)}
        >
          A doctor
        </button>
        <button
          type="button"
          className={`refsrc__chip ${answer === OTHER ? "refsrc__chip--on" : ""}`}
          onClick={() => choose(OTHER)}
        >
          Someone else
        </button>
      </div>

      {answer === DOCTOR && (
        <div className="refsrc__search">
          {picked ? (
            <div className="refsrc__picked">
              <span className="refsrc__picked-name">{picked.full_name}</span>
              <span className="refsrc__picked-meta">
                {[picked.specialty, picked.clinic_name, picked.area].filter(Boolean).join(" · ")}
              </span>
              <button
                type="button"
                className="refsrc__clear"
                onClick={() => {
                  onChange({ answer_type: DOCTOR, doctor_id: null, doctor: null });
                  setOpen(true);
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                className="refsrc__input"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Search name, clinic or phone"
                autoComplete="off"
                autoFocus
              />
              {open && query.trim().length >= 2 && (
                <ul className="refsrc__results">
                  {searching && <li className="refsrc__hint">Searching…</li>}
                  {!searching && results.length === 0 && (
                    <li className="refsrc__hint">
                      No match.{" "}
                      <button
                        type="button"
                        className="refsrc__link"
                        onClick={() => onChange({ answer_type: OTHER, free_text: query })}
                      >
                        Record “{query}” as free text
                      </button>
                    </li>
                  )}
                  {results.map((d) => (
                    <li key={d.doctor_id}>
                      <button
                        type="button"
                        className="refsrc__result"
                        onClick={() => pickDoctor(d)}
                      >
                        <span className="refsrc__result-name">{d.full_name}</span>
                        <span className="refsrc__result-meta">
                          {[d.specialty, d.clinic_name, d.area].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {answer === OTHER && (
        <input
          className="refsrc__input"
          value={value?.free_text || ""}
          onChange={(e) => onChange({ answer_type: OTHER, free_text: e.target.value })}
          placeholder="Who told them about us?"
          autoFocus
        />
      )}

      {error && <span className="refsrc__err">{error}</span>}
    </div>
  );
}

// A complete answer, or null. Callers use this for both the submit guard and
// the payload, so the two can never disagree about what counts as answered.
export function referralSourcePayload(value) {
  if (!value?.answer_type) return null;
  if (value.answer_type === SELF) return { answer_type: SELF };
  if (value.answer_type === DOCTOR) {
    return value.doctor_id ? { answer_type: DOCTOR, doctor_id: value.doctor_id } : null;
  }
  const text = (value.free_text || "").trim();
  return text ? { answer_type: OTHER, free_text: text } : null;
}

export const referralSourceLabel = label;
