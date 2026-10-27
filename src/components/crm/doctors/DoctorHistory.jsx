import { useState } from "react";
import api from "../../../services/api.js";
import { errorText } from "../import/importText.js";

const at = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const KIND = { added: "Added", removed: "Removed", restored: "Restored", edited: "Edited" };

export default function DoctorHistory({ doctorId, refreshKey }) {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState(null);
  const [loadedKey, setLoadedKey] = useState(null);

  const load = () => {
    setErr(null);
    api
      .get(`/api/crm/doctors/${doctorId}/history`)
      .then(({ data }) => {
        setEntries(data.entries);
        setLoadedKey(refreshKey);
      })
      .catch((e) => setErr(errorText(e, "Unable to load the change history.")));
  };

  return (
    <details
      className="d360__section dfm__history"
      onToggle={(e) => {
        if (e.currentTarget.open && (entries === null || loadedKey !== refreshKey)) load();
      }}
    >
      <summary className="rep__label">Change history</summary>
      {err && (
        <p className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {!err && entries === null && <p className="rep__hint">Loading…</p>}
      {entries?.length === 0 && <p className="rep__hint">No changes recorded yet.</p>}
      {entries?.length > 0 && (
        <ol className="dfm__changes">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <div className="dfm__change-head">
                <strong>{KIND[e.kind]}</strong>
                <span>
                  {e.by || "System"} · {at(e.at)}
                </span>
              </div>
              {e.changes.length > 0 && (
                <ul>
                  {e.changes.map((c) => (
                    <li key={c.field}>
                      <span className="dfm__change-field">{c.field}</span>{" "}
                      <span className="dfm__change-from">{c.from ?? "empty"}</span>
                      {" → "}
                      <span className="dfm__change-to">{c.to ?? "cleared"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
